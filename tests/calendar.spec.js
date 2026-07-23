import { test, expect } from '@playwright/test';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Títulos únicos por teste evitam colisão com os dados semente; não é preciso
// apagar o IndexedDB (fazer isso após o app abrir a conexão só trava e gera
// flakiness sob carga).
test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
});

test.describe('formato do evento (buildEventBody)', () => {
  test('tarefa com horário vira evento cronometrado de 1h', async ({ page }) => {
    const ev = await page.evaluate(async () => {
      const { buildEventBody } = await import('/src/integrations/googleCalendar.js');
      return buildEventBody({ title: 'Reunião', priority: 'high', due: '2026-07-24', dueTime: '10:00' });
    });

    expect(ev.summary).toBe('📋 Reunião');
    // Cronometrado: dateTime + timeZone, sem campo de dia inteiro
    expect(ev.start.dateTime).toBe('2026-07-24T10:00:00');
    expect(ev.start.date).toBeUndefined();
    expect(ev.start.timeZone).toBeTruthy();
    // Fim = início + 1h
    expect(ev.end.dateTime).toBe('2026-07-24T11:00:00');
  });

  test('horário perto da meia-noite rola para o dia seguinte', async ({ page }) => {
    const ev = await page.evaluate(async () => {
      const { buildEventBody } = await import('/src/integrations/googleCalendar.js');
      return buildEventBody({ title: 'Plantão', priority: 'medium', due: '2026-07-24', dueTime: '23:30' });
    });

    expect(ev.start.dateTime).toBe('2026-07-24T23:30:00');
    expect(ev.end.dateTime).toBe('2026-07-25T00:30:00');
  });

  test('tarefa sem horário continua sendo evento de dia inteiro', async ({ page }) => {
    const ev = await page.evaluate(async () => {
      const { buildEventBody } = await import('/src/integrations/googleCalendar.js');
      return buildEventBody({ title: 'Pagar boleto', priority: 'low', due: '2026-07-24', dueTime: '' });
    });

    expect(ev.start.date).toBe('2026-07-24');
    expect(ev.start.dateTime).toBeUndefined();
    expect(ev.end.date).toBe('2026-07-24');
  });
});

test.describe('horário na UI', () => {
  test('criar tarefa com hora pelo formulário mostra o horário e persiste', async ({ page }) => {
    await page.click('#btn-open-task-form');
    await page.fill('#task-title', 'Reunião com o cliente');
    await page.fill('#task-due', '2026-07-24');
    await page.fill('#task-time', '10:00');
    await page.click('#task-form button[type="submit"]');

    const item = page.locator('.task-item', { hasText: 'Reunião com o cliente' });
    await expect(item.locator('.task-due-date')).toContainText('🕒 10:00');

    // Sobrevive ao reload
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('.task-item', { hasText: 'Reunião com o cliente' }).locator('.task-due-date')).toContainText('🕒 10:00');
  });

  test('editar pré-preenche a hora e permite removê-la', async ({ page }) => {
    await page.click('#btn-open-task-form');
    await page.fill('#task-title', 'Consulta médica');
    await page.fill('#task-due', '2026-07-25');
    await page.fill('#task-time', '14:30');
    await page.click('#task-form button[type="submit"]');

    await page.locator('.task-item', { hasText: 'Consulta médica' }).locator('.btn-edit-task').click();
    await expect(page.locator('#task-time')).toHaveValue('14:30');

    // Remove a hora -> volta a tarefa de dia inteiro
    await page.fill('#task-time', '');
    await page.click('#task-form button[type="submit"]');

    const dateLabel = page.locator('.task-item', { hasText: 'Consulta médica' }).locator('.task-due-date');
    await expect(dateLabel).not.toContainText('🕒');
    await expect(dateLabel).toContainText('📅');
  });

  test('tarefa sem prazo não mostra horário mesmo que a hora seja preenchida', async ({ page }) => {
    await page.click('#btn-open-task-form');
    await page.fill('#task-title', 'Tarefa solta');
    await page.fill('#task-time', '09:00'); // sem data
    await page.click('#task-form button[type="submit"]');

    await expect(page.locator('.task-item', { hasText: 'Tarefa solta' }).locator('.task-due-date')).toHaveCount(0);
  });
});

test('agente cria compromisso com hora via criar_tarefa', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('genesis_api_key', 'gsk_fake_test_key'));
  await page.reload({ waitUntil: 'networkidle' });

  let call = 0;
  await page.route(GROQ_URL, async (route) => {
    call++;
    if (call === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'criar_tarefa', arguments: JSON.stringify({ titulo: 'Reunião de alinhamento', prazo: '2026-07-24', hora: '10:00' }) }
              }]
            }
          }]
        })
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Compromisso criado para 24/07 às 10:00.' } }] })
      });
    }
  });

  await page.fill('#chat-input', 'marca uma reunião de alinhamento dia 24/07 às 10h');
  await page.click('#btn-send');

  const item = page.locator('.task-item', { hasText: 'Reunião de alinhamento' });
  await expect(item).toBeVisible({ timeout: 10000 });
  await expect(item.locator('.task-due-date')).toContainText('🕒 10:00');
});
