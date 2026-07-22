import { test, expect } from '@playwright/test';

// E2E da camada de memória durável: perfil injetado no prompt, tool
// lembrar_fato e tool buscar_historico.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('genesis');
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
    req.onblocked = resolve;
  }));
  await page.evaluate(() => localStorage.setItem('genesis_api_key', 'gsk_fake_test_key'));
  await page.reload({ waitUntil: 'networkidle' });
});

// Roteia a Groq com respostas roteirizadas e captura os payloads enviados,
// para inspecionar o system prompt montado.
async function mockGroq(page, replies) {
  const payloads = [];
  let call = 0;
  await page.route(GROQ_URL, async (route) => {
    payloads.push(route.request().postDataJSON());
    const reply = replies[Math.min(call, replies.length - 1)];
    call++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(reply)
    });
  });
  return payloads;
}

function textReply(content) {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

function toolReply(name, args, id = 'call_1') {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
      }
    }]
  };
}

test('lembrar_fato persiste o fato e ele aparece no system prompt do turno seguinte', async ({ page }) => {
  const payloads = await mockGroq(page, [
    toolReply('lembrar_fato', { fato: 'Trabalha como dev freelancer e fatura por projeto', categoria: 'negocio' }),
    textReply('Anotado.'),
    textReply('Beleza.')
  ]);

  await page.fill('#chat-input', 'sou dev freelancer, faturo por projeto');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Anotado.' })).toBeVisible({ timeout: 10000 });

  // Segunda mensagem: o fato já deve estar no system prompt
  await page.fill('#chat-input', 'e aí');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Beleza.' })).toBeVisible({ timeout: 10000 });

  const lastSystem = payloads[payloads.length - 1].messages[0].content;
  expect(lastSystem).toContain('FATOS APRENDIDOS');
  expect(lastSystem).toContain('Trabalha como dev freelancer');
  expect(lastSystem).toContain('negocio|');
});

test('fato memorizado sobrevive ao reload', async ({ page }) => {
  await mockGroq(page, [
    toolReply('lembrar_fato', { fato: 'Prefere trabalhar de manhã cedo', categoria: 'preferencia' }),
    textReply('Ok.')
  ]);

  await page.fill('#chat-input', 'rendo muito mais de manhã cedo');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Ok.' })).toBeVisible({ timeout: 10000 });

  await page.reload({ waitUntil: 'networkidle' });
  const payloads = await mockGroq(page, [textReply('Oi!')]);
  await page.fill('#chat-input', 'oi');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Oi!' })).toBeVisible({ timeout: 10000 });

  expect(payloads[0].messages[0].content).toContain('Prefere trabalhar de manhã cedo');
});

test('fato duplicado atualiza o existente em vez de empilhar', async ({ page }) => {
  const payloads = await mockGroq(page, [
    toolReply('lembrar_fato', { fato: 'Trabalha como dev freelancer', categoria: 'negocio' }),
    textReply('Ok.'),
    toolReply('lembrar_fato', { fato: 'Trabalha como dev freelancer full-stack', categoria: 'negocio' }, 'call_2'),
    textReply('Atualizado.'),
    textReply('Oi!')
  ]);

  await page.fill('#chat-input', 'sou dev freelancer');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Ok.' })).toBeVisible({ timeout: 10000 });

  await page.fill('#chat-input', 'na verdade sou dev freelancer full-stack');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Atualizado.' })).toBeVisible({ timeout: 10000 });

  await page.fill('#chat-input', 'oi');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Oi!' })).toBeVisible({ timeout: 10000 });

  const lastSystem = payloads[payloads.length - 1].messages[0].content;
  const factLines = lastSystem.split('\n').filter((l) => l.startsWith('negocio|'));
  expect(factLines).toHaveLength(1);
  expect(factLines[0]).toContain('full-stack');
});
