import { test, expect } from '@playwright/test';
import { buildBriefing, MAX_SUGGESTIONS } from '../src/agent/briefing.js';

// Testes unitários da buildBriefing — função pura, roda direto no Node, sem
// navegador. `now` é sempre injetado, então os cenários são determinísticos.

// Quarta-feira, 22/07/2026 às 08:00 (manhã).
const NOW = new Date(2026, 6, 22, 8, 0, 0);
const TODAY = '2026-07-22';
const YESTERDAY = '2026-07-21';
const TWO_DAYS_AGO = '2026-07-20';
const THREE_DAYS_AGO = '2026-07-19';

function task(overrides) {
  return {
    id: 't1',
    title: 'Tarefa',
    priority: 'medium',
    due: '',
    completed: false,
    rescheduleCount: 0,
    ...overrides
  };
}

function at(dateStr, hour = 10) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, hour).getTime();
}

test.describe('buildBriefing', () => {
  test('dia limpo: saudação curta, sem inventar preocupação', () => {
    const b = buildBriefing({
      tasks: [],
      habits: [],
      moods: { [TODAY]: 4 },
      profile: { core: 'Fundador de agência', learned: [] },
      now: NOW
    });

    expect(b.greeting).toBe('Bom dia');
    expect(b.highlights).toHaveLength(1);
    expect(b.highlights[0].type).toBe('clear');
    expect(b.suggestions).toEqual([]);
    expect(b.rawText).toBe('Bom dia. Nada pendente por aqui.');
  });

  test('tarefas de hoje e atrasadas aparecem juntas no mesmo highlight', () => {
    const b = buildBriefing({
      tasks: [
        task({ id: 'a', due: TODAY }),
        task({ id: 'b', due: TODAY }),
        task({ id: 'c', due: TWO_DAYS_AGO }),
        task({ id: 'd', due: TODAY, completed: true, completedAt: at(TODAY) })
      ],
      habits: [],
      moods: { [TODAY]: 3 },
      profile: { core: 'x', learned: [] },
      now: NOW
    });

    const tasksHighlight = b.highlights.find(h => h.type === 'tasks_today');
    expect(tasksHighlight.text).toBe('3 tarefas pendentes para hoje (1 atrasada).');
  });

  test('só atrasadas, sem nada para hoje', () => {
    const b = buildBriefing({
      tasks: [task({ due: THREE_DAYS_AGO })],
      habits: [],
      moods: { [TODAY]: 3 },
      profile: { core: 'x', learned: [] },
      now: NOW
    });

    expect(b.highlights[0]).toMatchObject({ type: 'tasks_overdue', text: '1 tarefa atrasada.' });
  });

  test('streak quebrado é reportado com o tamanho que tinha', () => {
    // Feito em 18, 19 e 20; nada em 21 (ontem) nem hoje -> streak de 3 morreu
    const b = buildBriefing({
      tasks: [],
      habits: [{
        id: 'h1',
        name: 'Beber 2L de água',
        history: { '2026-07-18': true, '2026-07-19': true, [TWO_DAYS_AGO]: true }
      }],
      moods: { [TODAY]: 3 },
      profile: { core: 'x', learned: [] },
      now: NOW
    });

    const broken = b.highlights.find(h => h.type === 'habit_streak_broken');
    expect(broken.text).toBe('Você quebrou um streak de 3 dias em "Beber 2L de água".');
    expect(broken.habitId).toBe('h1');
    // E vira sugestão de retomada
    expect(b.suggestions.some(s => s.type === 'habit_restart')).toBe(true);
  });

  test('streak vivo mas não marcado hoje aparece como em risco, não como quebrado', () => {
    const b = buildBriefing({
      tasks: [],
      habits: [{
        id: 'h1',
        name: 'Ler 10 páginas',
        history: { [THREE_DAYS_AGO]: true, [TWO_DAYS_AGO]: true, [YESTERDAY]: true }
      }],
      moods: { [TODAY]: 3 },
      profile: { core: 'x', learned: [] },
      now: NOW
    });

    expect(b.highlights.some(h => h.type === 'habit_streak_broken')).toBe(false);
    const atRisk = b.highlights.find(h => h.type === 'habit_streak_at_risk');
    expect(atRisk.text).toBe('Streak de 3 dias em "Ler 10 páginas" ainda não marcado hoje.');
  });

  test('dias sem registrar humor', () => {
    const b = buildBriefing({
      tasks: [],
      habits: [],
      moods: { '2026-07-18': 4 }, // 4 dias atrás
      profile: { core: 'x', learned: [] },
      now: NOW
    });

    expect(b.highlights.find(h => h.type === 'mood_gap').text).toBe('Faz 4 dias sem registrar humor.');
  });

  test('humor registrado recentemente não vira highlight', () => {
    const b = buildBriefing({
      tasks: [],
      habits: [],
      moods: { [YESTERDAY]: 4 },
      profile: { core: 'x', learned: [] },
      now: NOW
    });

    expect(b.highlights.some(h => h.type.startsWith('mood'))).toBe(false);
  });

  test('humor nunca registrado é dito de outra forma', () => {
    const b = buildBriefing({
      tasks: [], habits: [], moods: {},
      profile: { core: 'x', learned: [] },
      now: NOW
    });

    expect(b.highlights.find(h => h.type === 'mood_never').text).toBe('Você ainda não registrou seu humor.');
  });

  test('resumo de ontem usa "X de Y" quando havia prazo ontem', () => {
    const b = buildBriefing({
      tasks: [
        task({ id: 'a', due: YESTERDAY, completed: true, completedAt: at(YESTERDAY) }),
        task({ id: 'b', due: YESTERDAY, completed: true, completedAt: at(YESTERDAY) }),
        task({ id: 'c', due: YESTERDAY }),
        task({ id: 'd', due: YESTERDAY })
      ],
      habits: [],
      moods: { [TODAY]: 3 },
      profile: { core: 'x', learned: [] },
      now: NOW
    });

    expect(b.highlights.find(h => h.type === 'yesterday').text).toBe('Ontem você concluiu 2 de 4.');
  });

  test('tarefa adiada 3+ vezes gera sugestão de quebrar em partes', () => {
    const b = buildBriefing({
      tasks: [task({ id: 'task_9', title: 'Refazer o contrato', due: TODAY, rescheduleCount: 4 })],
      habits: [],
      moods: { [TODAY]: 3 },
      profile: { core: 'x', learned: [] },
      now: NOW
    });

    const suggestion = b.suggestions.find(s => s.type === 'zombie_task');
    expect(suggestion.text).toBe('"Refazer o contrato" já foi adiada 4x — quer quebrar em partes menores?');
    expect(suggestion.taskId).toBe('task_9');
  });

  test('adiamento abaixo do limiar não gera sugestão', () => {
    const b = buildBriefing({
      tasks: [task({ due: TODAY, rescheduleCount: 2 })],
      habits: [],
      moods: { [TODAY]: 3 },
      profile: { core: 'x', learned: [] },
      now: NOW
    });

    expect(b.suggestions).toEqual([]);
  });

  test('sugestões respeitam o teto', () => {
    const b = buildBriefing({
      tasks: [
        task({ id: 'a', title: 'Adiada', due: THREE_DAYS_AGO, rescheduleCount: 5 }),
        task({ id: 'b', due: THREE_DAYS_AGO }),
        task({ id: 'c', due: THREE_DAYS_AGO }),
        task({ id: 'd', due: THREE_DAYS_AGO })
      ],
      habits: [{ id: 'h1', name: 'Correr', history: { '2026-07-18': true, '2026-07-19': true, [TWO_DAYS_AGO]: true } }],
      moods: { [TODAY]: 3 },
      profile: { core: 'x', learned: [] },
      now: NOW
    });

    // Havia 3 gatilhos (zumbi, triagem de atrasadas, retomar hábito)
    expect(b.suggestions).toHaveLength(MAX_SUGGESTIONS);
  });

  test('perfil vazio em dia limpo sugere preencher a Memória', () => {
    const b = buildBriefing({
      tasks: [], habits: [], moods: { [TODAY]: 4 },
      profile: { core: '', learned: [] },
      now: NOW
    });

    expect(b.suggestions).toHaveLength(1);
    expect(b.suggestions[0].type).toBe('profile_setup');
  });

  test('saudação acompanha a hora injetada', () => {
    const base = { tasks: [], habits: [], moods: { [TODAY]: 3 }, profile: { core: 'x', learned: [] } };
    expect(buildBriefing({ ...base, now: new Date(2026, 6, 22, 7) }).greeting).toBe('Bom dia');
    expect(buildBriefing({ ...base, now: new Date(2026, 6, 22, 14) }).greeting).toBe('Boa tarde');
    expect(buildBriefing({ ...base, now: new Date(2026, 6, 22, 21) }).greeting).toBe('Boa noite');
  });

  test('é determinística e não depende do relógio real', () => {
    const input = {
      tasks: [task({ due: TODAY }), task({ id: 'x', due: TWO_DAYS_AGO })],
      habits: [{ id: 'h1', name: 'Correr', history: { [YESTERDAY]: true } }],
      moods: { '2026-07-17': 2 },
      profile: { core: 'Fundador', learned: [] },
      now: NOW
    };

    expect(buildBriefing(input).rawText).toBe(buildBriefing(input).rawText);
    expect(buildBriefing(input).rawText).toContain('2 tarefas pendentes para hoje (1 atrasada).');
  });

  test('chamada sem argumentos não quebra', () => {
    const b = buildBriefing();
    expect(b.greeting).toBeTruthy();
    expect(b.rawText).toContain(b.greeting);
  });
});

test.describe('briefing na UI', () => {
  // A primeira carga da página já exibe o briefing e grava a data — por isso
  // limpamos o registro pelo próprio módulo de persistência (apagar o banco
  // inteiro fica bloqueado enquanto o app mantém a conexão aberta).
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const db = await import('/src/db.js');
      await db.setSetting('lastBriefingDate', null);
    });
  });

  test('aparece ao abrir o app; dispensar e recarregar não mostra de novo', async ({ page }) => {
    await page.reload({ waitUntil: 'networkidle' });

    const card = page.locator('#briefing-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.briefing-greeting')).toHaveText(/Bom dia|Boa tarde|Boa noite/);
    await expect(card.locator('.briefing-highlight').first()).toBeVisible();

    // Dispensa: some da tela imediatamente
    await page.click('#btn-dismiss-briefing');
    await expect(card).toBeHidden();

    // Mesmo dia: não volta ao recarregar
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#briefing-card')).toBeHidden();
  });

  test('não repete no mesmo dia mesmo sem dispensar', async ({ page }) => {
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#briefing-card')).toBeVisible();

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#briefing-card')).toBeHidden();
  });

  test('volta a aparecer quando a data do último briefing é de outro dia', async ({ page }) => {
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#briefing-card')).toBeVisible();

    // Simula "ontem" no registro do último briefing
    await page.evaluate(async () => {
      const db = await import('/src/db.js');
      await db.setSetting('lastBriefingDate', '2020-01-01');
    });

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#briefing-card')).toBeVisible();
  });
});
