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

test('buscar_historico encontra uma nota antiga e devolve pro modelo', async ({ page }) => {
  // Cria a nota que será recuperada
  await page.click('button[data-tab="tab-notes"]');
  await page.click('#btn-new-note');
  await page.fill('#note-title-input', 'Decisão de preço');
  await page.fill('#note-body-input', 'Decidimos cobrar setup fee de 2500 nos contratos de automação.');
  await page.waitForTimeout(600);

  const payloads = await mockGroq(page, [
    toolReply('buscar_historico', { query: 'setup fee contratos' }),
    textReply('Você tinha decidido cobrar setup fee de 2500.')
  ]);

  await page.fill('#chat-input', 'o que eu tinha decidido sobre o preço?');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'setup fee de 2500' })).toBeVisible({ timeout: 10000 });

  // O resultado da tool volta como mensagem role:tool no payload seguinte
  const toolMessage = payloads[1].messages.find((m) => m.role === 'tool');
  expect(toolMessage).toBeTruthy();
  expect(toolMessage.content).toContain('setup fee');
  expect(toolMessage.content).toContain('nota');
});

test('buscar_historico também encontra tarefas concluídas', async ({ page }) => {
  await page.click('#btn-open-task-form');
  await page.fill('#task-title', 'Migrar o site para o novo servidor');
  await page.click('#task-form button[type="submit"]');
  await page.locator('.task-item', { hasText: 'Migrar o site' }).locator('.custom-checkbox').click();

  const payloads = await mockGroq(page, [
    toolReply('buscar_historico', { query: 'migrar site servidor' }),
    textReply('Foi concluída.')
  ]);

  await page.fill('#chat-input', 'quando foi que eu concluí a migração do site?');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Foi concluída.' })).toBeVisible({ timeout: 10000 });

  const toolMessage = payloads[1].messages.find((m) => m.role === 'tool');
  expect(toolMessage.content).toContain('Migrar o site');
  expect(toolMessage.content).toContain('tarefa');
  expect(toolMessage.content).toContain('conclu');
});

test('buscar_historico sem resultado devolve lista vazia, não erro', async ({ page }) => {
  const payloads = await mockGroq(page, [
    toolReply('buscar_historico', { query: 'zzzzz assunto inexistente' }),
    textReply('Não achei nada sobre isso.')
  ]);

  await page.fill('#chat-input', 'o que eu tinha decidido sobre zzzzz?');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Não achei nada' })).toBeVisible({ timeout: 10000 });

  const toolMessage = payloads[1].messages.find((m) => m.role === 'tool');
  const payload = JSON.parse(toolMessage.content);
  expect(payload.status).toBe('ok');
  expect(payload.results).toEqual([]);
});

test('perfil core editado pelo usuário entra no system prompt e persiste', async ({ page }) => {
  await page.click('#btn-memory');
  await page.fill('#memory-core-input', 'Fundador de uma agência de automação. Meta do trimestre: fechar 5 contratos recorrentes.');
  await page.click('#btn-save-memory-core');
  await page.click('#btn-close-memory-modal');

  await page.reload({ waitUntil: 'networkidle' });
  const payloads = await mockGroq(page, [textReply('Oi!')]);

  await page.fill('#chat-input', 'oi');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Oi!' })).toBeVisible({ timeout: 10000 });

  const systemPrompt = payloads[0].messages[0].content;
  expect(systemPrompt).toContain('PERFIL DO USUÁRIO');
  expect(systemPrompt).toContain('agência de automação');

  // E continua visível na view para inspeção
  await page.click('#btn-memory');
  await expect(page.locator('#memory-core-input')).toHaveValue(/agência de automação/);
});

test('usuário pode apagar um fato aprendido e ele some do prompt', async ({ page }) => {
  const payloads = await mockGroq(page, [
    toolReply('lembrar_fato', { fato: 'Mora em Belo Horizonte', categoria: 'contexto' }),
    textReply('Ok.'),
    textReply('Oi!')
  ]);

  await page.fill('#chat-input', 'moro em BH');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Ok.' })).toBeVisible({ timeout: 10000 });

  await page.click('#btn-memory');
  await expect(page.locator('.memory-fact-item')).toHaveCount(1);
  await expect(page.locator('.memory-fact-item')).toContainText('Belo Horizonte');

  await page.click('.memory-fact-item .btn-danger-icon');
  await expect(page.locator('.memory-fact-item')).toHaveCount(0);
  await page.click('#btn-close-memory-modal');

  // Some do prompt do turno seguinte
  await page.fill('#chat-input', 'oi');
  await page.click('#btn-send');
  await expect(page.locator('.chat-msg.agent', { hasText: 'Oi!' })).toBeVisible({ timeout: 10000 });
  expect(payloads[payloads.length - 1].messages[0].content).not.toContain('Belo Horizonte');

  // E continua apagado após reload
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('#btn-memory');
  await expect(page.locator('.memory-fact-item')).toHaveCount(0);
});

test('o bloco de perfil respeita o teto de caracteres com a memória cheia', async ({ page }) => {
  // Enche o perfil no limite: core acima do teto + 50 fatos distintos entre si
  // (textos parecidos seriam consolidados pelo dedup, não empilhados).
  await page.evaluate(async (chars) => {
    const { saveCoreProfile, rememberFact } = await import('/src/agent/profile.js');
    await saveCoreProfile('C'.repeat(chars + 200));

    // Tokens únicos dominam cada texto para que o dedup fuzzy não os
    // consolide — aqui queremos exercitar o teto, não a consolidação.
    for (let i = 0; i < 50; i++) {
      const token = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      await rememberFact(`Projeto ${token} com escopo ${token.split('').reverse().join('')}`, 'contexto');
    }
  }, 600);

  const built = await page.evaluate(async () => {
    const { buildProfileContext, PROFILE_CONTEXT_BUDGET, getProfile } = await import('/src/agent/profile.js');
    const block = buildProfileContext();
    return {
      length: block.length,
      budget: PROFILE_CONTEXT_BUDGET,
      storedFacts: getProfile().learned.length,
      linesInBlock: block.split('\n').filter((l) => l.startsWith('contexto|')).length,
      block
    };
  });

  expect(built.storedFacts).toBe(50);
  // Cabe no teto e trunca de verdade (nem todos os fatos entram no prompt)
  expect(built.length).toBeLessThanOrEqual(built.budget);
  expect(built.linesInBlock).toBeGreaterThan(0);
  expect(built.linesInBlock).toBeLessThan(built.storedFacts);
  expect(built.block).toContain('PERFIL DO USUÁRIO');
  expect(built.block).toContain('FATOS APRENDIDOS');
});
