import { test, expect, devices } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
});

test('dashboard loads with no console errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await expect(page.locator('h1')).toHaveText('Gênesis');
  await expect(page.locator('#stats-tasks-completed')).toBeVisible();
  expect(errors).toEqual([]);
});

test('create, complete and delete a task', async ({ page }) => {
  await page.click('#btn-open-task-form');
  await page.fill('#task-title', 'Tarefa de teste automatizado');
  await page.click('#task-form button[type="submit"]');

  const taskItem = page.locator('.task-item', { hasText: 'Tarefa de teste automatizado' });
  await expect(taskItem).toBeVisible();

  await taskItem.locator('.custom-checkbox').click();
  await expect(taskItem).toHaveClass(/completed/);

  await taskItem.locator('.btn-delete-task').click();
  await expect(page.locator('.task-item', { hasText: 'Tarefa de teste automatizado' })).toHaveCount(0);
});

test('create a habit and toggle today', async ({ page }) => {
  await page.click('button[data-tab="tab-habits"]');
  await page.click('#btn-open-habit-form');
  await page.fill('#habit-name', 'Hábito de teste');
  await page.click('#habit-form button[type="submit"]');

  const habitItem = page.locator('.habit-item', { hasText: 'Hábito de teste' });
  await expect(habitItem).toBeVisible();

  await habitItem.locator('.habit-day-btn').last().click();
  await expect(habitItem.locator('.habit-day-btn').last()).toHaveClass(/completed/);

  await habitItem.locator('.btn-delete-habit').click();
  await expect(page.locator('.habit-item', { hasText: 'Hábito de teste' })).toHaveCount(0);
});

test('create and edit a note', async ({ page }) => {
  await page.click('button[data-tab="tab-notes"]');
  await page.click('#btn-new-note');

  await page.fill('#note-title-input', 'Nota de teste');
  await page.fill('#note-body-input', '# Conteúdo\nLinha de teste.');

  await expect(page.locator('.note-item.active .note-item-title')).toHaveText('Nota de teste');
});

test('mood tracker selects today\'s mood', async ({ page }) => {
  await page.click('.mood-btn[data-mood="5"]');
  await expect(page.locator('.mood-btn[data-mood="5"]')).toHaveClass(/active/);
});

test('weekly report modal opens with stats', async ({ page }) => {
  await page.click('#btn-weekly-report');
  await expect(page.locator('#report-modal')).not.toHaveClass(/hidden/);
  await expect(page.locator('.report-stat-row')).toHaveCount(6);
  await page.click('#btn-close-report-modal');
  await expect(page.locator('#report-modal')).toHaveClass(/hidden/);
});

test('weekly report flags a zombie task and "fazer agora" bumps its priority', async ({ page }) => {
  await page.evaluate(async () => {
    const req = indexedDB.open('genesis-db');
    const db = await new Promise((resolve) => { req.onsuccess = () => resolve(req.result); });
    const zombieTask = {
      id: 'task_zombie_test', title: 'Tarefa zumbi de teste', priority: 'medium', due: '',
      recurrence: '', completed: false, createdAt: Date.now() - 20 * 86400000, rescheduleCount: 4
    };
    await new Promise((resolve) => {
      const tx = db.transaction('tasks', 'readwrite');
      tx.objectStore('tasks').put(zombieTask);
      tx.oncomplete = resolve;
    });
  });
  await page.reload({ waitUntil: 'networkidle' });

  await page.click('#btn-weekly-report');
  const zombieItem = page.locator('.zombie-task-item', { hasText: 'Tarefa zumbi de teste' });
  await expect(zombieItem).toBeVisible();
  await expect(zombieItem.locator('.zombie-task-reason')).toContainText('reagendada 4x');

  await zombieItem.locator('.zombie-do-now').click();
  const taskItem = page.locator('.task-item', { hasText: 'Tarefa zumbi de teste' });
  await expect(taskItem.locator('.task-priority-badge')).toHaveText('Alta');
});

test('chat responds in simulated mode without an API key', async ({ page }) => {
  await page.fill('#chat-input', 'Quais são minhas tarefas pendentes?');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent').last()).toContainText(/Tarefas|tarefa/i, { timeout: 5000 });
});

test('notifications button is present and does not throw when clicked', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.click('#btn-notifications');
  await page.waitForTimeout(200);
  expect(errors).toEqual([]);
});

test('edit an existing task', async ({ page }) => {
  await page.click('#btn-open-task-form');
  await page.fill('#task-title', 'Tarefa original');
  await page.click('#task-form button[type="submit"]');

  const taskItem = page.locator('.task-item', { hasText: 'Tarefa original' });
  await taskItem.locator('.btn-edit-task').click();

  await expect(page.locator('#task-form button[type="submit"]')).toHaveText('Salvar Alterações');
  await page.fill('#task-title', 'Tarefa editada');
  await page.selectOption('#task-priority', 'high');
  await page.click('#task-form button[type="submit"]');

  await expect(page.locator('.task-item', { hasText: 'Tarefa editada' })).toBeVisible();
  await expect(page.locator('.task-item', { hasText: 'Tarefa original' })).toHaveCount(0);
});

test('header buttons stay clickable and do not overlap the dashboard (regression)', async ({ page }) => {
  // Guards against the header-actions wrapping bug where a second row of
  // header buttons rendered underneath the fixed-height dashboard content.
  await page.click('#btn-weekly-report');
  await expect(page.locator('#report-modal')).not.toHaveClass(/hidden/);
  await page.click('#btn-close-report-modal');

  await page.click('#btn-google-calendar');
  await expect(page.locator('#calendar-modal')).not.toHaveClass(/hidden/);
  await page.click('#btn-close-calendar-modal');
});

test('export data downloads a JSON backup file', async ({ page }) => {
  await page.click('#btn-backup');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-export-data')
  ]);
  expect(download.suggestedFilename()).toMatch(/genesis-backup-.*\.json/);
});

test('backup reminder badge shows on a fresh install and clears after a manual export', async ({ page }) => {
  await expect(page.locator('#btn-backup')).toHaveClass(/needs-backup/);

  await page.click('#btn-backup');
  await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-export-data')
  ]);

  await expect(page.locator('#btn-backup')).not.toHaveClass(/needs-backup/);
});

test('theme toggle switches and persists across reload', async ({ page }) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.click('#btn-theme-toggle');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('search finds a task and jumps to it', async ({ page }) => {
  await page.click('#btn-open-task-form');
  await page.fill('#task-title', 'Encontrar via busca global');
  await page.click('#task-form button[type="submit"]');

  await page.click('button[data-tab="tab-notes"]');

  await page.click('#btn-search');
  await page.fill('#search-input', 'busca global');
  const result = page.locator('.search-result-item', { hasText: 'Encontrar via busca global' });
  await expect(result).toBeVisible();
  await result.click();

  await expect(page.locator('#search-modal')).toHaveClass(/hidden/);
  await expect(page.locator('.tab-content#tab-tasks')).toHaveClass(/active/);
  await expect(page.locator('.task-item', { hasText: 'Encontrar via busca global' })).toBeVisible();
});

test('fuzzy note search tolerates typos and highlights the match', async ({ page }) => {
  await page.click('button[data-tab="tab-notes"]');
  await page.click('#btn-new-note');
  await page.fill('#note-title-input', 'Nota sobre planejamento financeiro');
  await page.fill('#note-body-input', 'Preciso organizar o orçamento mensal e cortar gastos supérfluos.');
  await page.waitForTimeout(500); // let the debounced note save land

  await page.click('#btn-search');
  await page.fill('#search-input', 'orcamneto mensl'); // deliberate typos
  const result = page.locator('.search-result-item', { hasText: 'planejamento financeiro' });
  await expect(result).toBeVisible();
  await expect(result.locator('mark')).toHaveCount(1);
});

test('completing a recurring task spawns the next occurrence', async ({ page }) => {
  await page.click('#btn-open-task-form');
  await page.fill('#task-title', 'Tarefa recorrente semanal');
  await page.selectOption('#task-recurrence', 'weekly');
  await page.click('#task-form button[type="submit"]');

  const original = page.locator('.task-item', { hasText: 'Tarefa recorrente semanal' }).first();
  await original.locator('.custom-checkbox').click();

  // Completing it spawns a fresh next occurrence — one completed, one pending
  await expect(page.locator('.task-item', { hasText: 'Tarefa recorrente semanal' })).toHaveCount(2);
  const completedCount = await page.locator('.task-item.completed', { hasText: 'Tarefa recorrente semanal' }).count();
  const pendingCount = await page.locator('.task-item:not(.completed)', { hasText: 'Tarefa recorrente semanal' }).count();
  expect(completedCount).toBe(1);
  expect(pendingCount).toBe(1);
});

test.describe('mobile viewport', () => {
  const { defaultBrowserType, ...iPhone13 } = devices['iPhone 13'];
  test.use({ ...iPhone13 });

  // Regression guard: .app-main once had a fixed calc() height inherited from
  // a stale desktop assumption, which produced a huge empty gap between the
  // chat panel and the dashboard content when stacked on a phone-width screen.
  test('no large empty gap between chat panel and dashboard content', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });

    const chatBottom = await page.locator('.panel-chat').evaluate((el) => el.getBoundingClientRect().bottom);
    const dashboardTop = await page.locator('.dashboard-content').evaluate((el) => el.getBoundingClientRect().top);

    // Some border/margin is fine; a layout regression produces a gap of
    // hundreds of pixels of dead space between the two stacked sections.
    expect(dashboardTop - chatBottom).toBeLessThan(50);
  });

  test('note editor action buttons stay on screen', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });

    await page.click('button[data-tab="tab-notes"]');
    const previewBtn = page.locator('#btn-toggle-preview');
    const box = await previewBtn.boundingBox();
    const viewportWidth = page.viewportSize().width;

    expect(box).not.toBeNull();
    expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth);
  });
});

test('import restores data from a backup file', async ({ page }) => {
  const backup = {
    genesisBackupVersion: 1,
    tasks: [{ id: 't_import', title: 'Tarefa importada', priority: 'high', due: '', completed: false }],
    habits: [],
    notes: [],
    moods: {},
    chatHistory: []
  };

  await page.click('#btn-backup');

  page.on('dialog', (dialog) => dialog.accept());
  await page.setInputFiles('#import-file-input', {
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup))
  });

  await page.click('#btn-close-backup-modal');
  await expect(page.locator('.task-item', { hasText: 'Tarefa importada' })).toBeVisible();
});

test.describe('quick capture (natural language)', () => {
  test('Ctrl+K focuses the quick capture input', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('#quick-capture-input')).toBeFocused();
  });

  test('classifies and creates a task with a relative date (simulated mode)', async ({ page }) => {
    await page.fill('#quick-capture-input', 'Ligar pro dentista amanhã, prioridade alta');
    await page.keyboard.press('Enter');

    await expect(page.locator('.quick-capture-type-label')).toContainText('Tarefa');
    await expect(page.locator('#qc-prioridade')).toHaveValue('high');
    const prazo = await page.inputValue('#qc-prazo');
    expect(prazo).not.toBe('');

    await page.click('#qc-save');
    await expect(page.locator('.task-item', { hasText: 'Ligar pro dentista amanhã' })).toBeVisible();
  });

  test('classifies mood phrasing as humor and saves it', async ({ page }) => {
    await page.fill('#quick-capture-input', 'estou me sentindo ótimo hoje');
    await page.keyboard.press('Enter');

    await expect(page.locator('.quick-capture-type-label')).toContainText('Humor');
    await expect(page.locator('.qc-mood-btn[data-mood="5"]')).toHaveClass(/active/);

    await page.click('#qc-save');
    await expect(page.locator('.mood-btn[data-mood="5"]')).toHaveClass(/active/);
  });

  test('classifies an "ideia:" prefix as a note', async ({ page }) => {
    await page.fill('#quick-capture-input', 'ideia: cobrar setup fee nos contratos de automação');
    await page.keyboard.press('Enter');

    await expect(page.locator('.quick-capture-type-label')).toContainText('Nota');
    await page.click('#qc-save');

    await page.click('button[data-tab="tab-notes"]');
    await expect(page.locator('.note-item', { hasText: 'cobrar setup fee' })).toBeVisible();
  });
});

test('recovers from a Groq "leaked function call" 400 error and still executes the tool', async ({ page }) => {
  // Simulates the exact failure mode Groq/Llama occasionally produces: the
  // tool call leaks out as pseudo-XML text instead of the structured
  // tool_calls field. The app should parse it back out and still act on it.
  await page.evaluate(() => localStorage.setItem('genesis_api_key', 'gsk_fake_test_key'));
  await page.reload({ waitUntil: 'networkidle' });

  let callCount = 0;
  await page.route('https://api.groq.com/openai/v1/chat/completions', async (route) => {
    callCount++;
    if (callCount === 1) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            message: 'Failed to call a function. Please adjust your prompt.',
            type: 'invalid_request_error',
            code: 'tool_use_failed',
            failed_generation: '<function=criar_tarefa{"titulo": "Tarefa recuperada do erro"}</function>'
          }
        })
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Tarefa criada com sucesso.' } }] })
      });
    }
  });

  await page.fill('#chat-input', 'Cria uma tarefa de teste');
  await page.click('#btn-send');

  await expect(page.locator('.task-item', { hasText: 'Tarefa recuperada do erro' })).toBeVisible({ timeout: 10000 });
});
