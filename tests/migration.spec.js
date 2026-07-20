import { test, expect } from '@playwright/test';

test('migrates legacy localStorage data into IndexedDB and clears it afterward', async ({ page }) => {
  // Seed legacy localStorage BEFORE any app script runs — this mirrors an
  // existing user loading the new IndexedDB-backed version for the first time.
  await page.addInitScript(() => {
    localStorage.setItem('genesis_tasks', JSON.stringify([
      { id: 'legacy_t1', title: 'Tarefa legada do localStorage', priority: 'high', due: '', completed: false }
    ]));
    localStorage.setItem('genesis_habits', JSON.stringify([
      { id: 'legacy_h1', name: 'Habito legado', history: { '2026-07-10': true, '2026-07-11': false } }
    ]));
    localStorage.setItem('genesis_notes', JSON.stringify([
      { id: 'legacy_n1', title: 'Nota legada', body: 'conteudo antigo', updatedAt: Date.now() }
    ]));
    localStorage.setItem('genesis_moods', JSON.stringify({ '2026-07-10': 4 }));
  });

  await page.goto('/', { waitUntil: 'networkidle' });

  await expect(page.locator('.task-item', { hasText: 'Tarefa legada do localStorage' })).toBeVisible();

  const remainingLegacyKeys = await page.evaluate(() => ({
    tasks: localStorage.getItem('genesis_tasks'),
    habits: localStorage.getItem('genesis_habits'),
    notes: localStorage.getItem('genesis_notes'),
    moods: localStorage.getItem('genesis_moods')
  }));
  expect(remainingLegacyKeys).toEqual({ tasks: null, habits: null, notes: null, moods: null });

  // Reload to confirm stability: no re-migration, no duplication, no mock-data reseed
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.task-item', { hasText: 'Tarefa legada do localStorage' })).toBeVisible();
  await expect(page.locator('.task-item')).toHaveCount(1);

  await page.click('button[data-tab="tab-habits"]');
  await expect(page.locator('.habit-item', { hasText: 'Habito legado' })).toBeVisible();

  await page.click('button[data-tab="tab-notes"]');
  await expect(page.locator('.note-item', { hasText: 'Nota legada' })).toBeVisible();
});

test('fresh install with no legacy data seeds starter content once', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const initialCount = await page.locator('.task-item').count();
  expect(initialCount).toBeGreaterThan(0);

  // Delete every task, reload, and confirm it stays empty instead of reseeding
  const deleteButtons = page.locator('.btn-delete-task');
  let remaining = await deleteButtons.count();
  while (remaining > 0) {
    await deleteButtons.first().click();
    remaining = await deleteButtons.count();
  }
  await expect(page.locator('.task-item')).toHaveCount(0);

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.task-item')).toHaveCount(0);
});
