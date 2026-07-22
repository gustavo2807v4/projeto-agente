import { test, expect } from '@playwright/test';

// E2E do roteamento de modelo: confirma que o chat despacha pro provider
// certo e que qualquer falha do modelo forte cai no Groq sem deixar o
// usuário sem resposta.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
});

// Instala as duas chaves e recarrega, deixando o app em modo "IA real".
async function withBothKeys(page) {
  await page.evaluate(() => {
    localStorage.setItem('genesis_api_key', 'gsk_fake_test_key');
    localStorage.setItem('genesis_anthropic_api_key', 'sk-ant-fake_test_key');
  });
  await page.reload({ waitUntil: 'networkidle' });
}

function anthropicReply(text) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn'
    })
  };
}

function groqReply(text) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] })
  };
}

test('conversa aberta vai para o modelo forte', async ({ page }) => {
  await withBothKeys(page);

  let groqCalls = 0;
  let anthropicCalls = 0;
  await page.route(GROQ_URL, async (route) => { groqCalls++; await route.fulfill(groqReply('resposta groq')); });
  await page.route(ANTHROPIC_URL, async (route) => { anthropicCalls++; await route.fulfill(anthropicReply('resposta do modelo forte')); });

  await page.fill('#chat-input', 'como você acha que eu devia priorizar meus projetos esse trimestre?');
  await page.click('#btn-send');

  await expect(page.locator('.chat-msg.agent', { hasText: 'resposta do modelo forte' })).toBeVisible({ timeout: 10000 });
  expect(anthropicCalls).toBe(1);
  expect(groqCalls).toBe(0);
});

test('ação mecânica vai para a Groq, sem tocar no modelo forte', async ({ page }) => {
  await withBothKeys(page);

  let groqCalls = 0;
  let anthropicCalls = 0;
  await page.route(ANTHROPIC_URL, async (route) => { anthropicCalls++; await route.fulfill(anthropicReply('nao deveria ser chamado')); });
  await page.route(GROQ_URL, async (route) => {
    groqCalls++;
    if (groqCalls === 1) {
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
                function: { name: 'criar_tarefa', arguments: JSON.stringify({ titulo: 'Tarefa roteada pela Groq' }) }
              }]
            }
          }]
        })
      });
    } else {
      await route.fulfill(groqReply('Tarefa criada.'));
    }
  });

  await page.fill('#chat-input', 'cria uma tarefa de pagar o boleto amanhã');
  await page.click('#btn-send');

  await expect(page.locator('.task-item', { hasText: 'Tarefa roteada pela Groq' })).toBeVisible({ timeout: 10000 });
  expect(anthropicCalls).toBe(0);
});

test('falha do modelo forte cai no Groq e o usuário ainda recebe resposta', async ({ page }) => {
  await withBothKeys(page);

  const warnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning' && msg.text().includes('[router]')) warnings.push(msg.text());
  });

  let groqCalls = 0;
  await page.route(ANTHROPIC_URL, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } })
    });
  });
  await page.route(GROQ_URL, async (route) => { groqCalls++; await route.fulfill(groqReply('resposta de fallback da Groq')); });

  await page.fill('#chat-input', 'me ajuda a pensar na estratégia de preço do meu serviço');
  await page.click('#btn-send');

  await expect(page.locator('.chat-msg.agent', { hasText: 'resposta de fallback da Groq' })).toBeVisible({ timeout: 10000 });
  expect(groqCalls).toBe(1);
  expect(warnings.join('\n')).toContain('fallback → groq');
});

test('sem chave do modelo forte, conversa aberta cai no Groq', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('genesis_api_key', 'gsk_fake_test_key'));
  await page.reload({ waitUntil: 'networkidle' });

  let anthropicCalls = 0;
  await page.route(ANTHROPIC_URL, async (route) => { anthropicCalls++; await route.fulfill(anthropicReply('nao deveria ser chamado')); });
  await page.route(GROQ_URL, async (route) => { await route.fulfill(groqReply('resposta groq sem chave forte')); });

  await page.fill('#chat-input', 'me ajuda a pensar na estratégia de preço do meu serviço');
  await page.click('#btn-send');

  await expect(page.locator('.chat-msg.agent', { hasText: 'resposta groq sem chave forte' })).toBeVisible({ timeout: 10000 });
  expect(anthropicCalls).toBe(0);
});

test('modelo forte recebe as tools traduzidas e seu tool call é executado', async ({ page }) => {
  await withBothKeys(page);

  let anthropicPayload = null;
  let anthropicCalls = 0;
  await page.route(ANTHROPIC_URL, async (route) => {
    anthropicCalls++;
    if (anthropicCalls === 1) {
      anthropicPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          content: [{
            type: 'tool_use',
            id: 'toolu_01',
            name: 'criar_tarefa',
            input: { titulo: 'Tarefa criada pelo modelo forte' }
          }],
          stop_reason: 'tool_use'
        })
      });
    } else {
      await route.fulfill(anthropicReply('Pronto, criei a tarefa.'));
    }
  });
  await page.route(GROQ_URL, async (route) => { await route.fulfill(groqReply('nao deveria ser chamado')); });

  // Mensagem de recuperação de histórico → regra manda pro modelo forte
  await page.fill('#chat-input', 'o que eu tinha decidido sobre isso? cria o follow-up');
  await page.click('#btn-send');

  await expect(page.locator('.task-item', { hasText: 'Tarefa criada pelo modelo forte' })).toBeVisible({ timeout: 10000 });

  // Tools traduzidas para o formato da Anthropic (input_schema, sem wrapper function)
  expect(anthropicPayload.tools[0]).toHaveProperty('input_schema');
  expect(anthropicPayload.tools[0]).not.toHaveProperty('function');
  // System prompt extraído das mensagens para o parâmetro dedicado
  expect(anthropicPayload.system).toContain('Gênesis');
  expect(anthropicPayload.messages.some((m) => m.role === 'system')).toBe(false);
  // Parâmetro de sampling descartado (4.7+ rejeita com 400)
  expect(anthropicPayload).not.toHaveProperty('temperature');
});
