import { test, expect } from '@playwright/test';
import { pickModel, PROVIDERS } from '../src/agent/router.js';

// Testes unitários da pickModel — função pura, roda direto no Node,
// sem navegador. Cada teste cobre uma regra da precedência.

test.describe('pickModel (router de modelo)', () => {
  test('captura rápida / modos fora do chat vão sempre pra Groq', () => {
    expect(pickModel({ mode: 'capture', messageText: 'dentista terça 15h' }).provider).toBe(PROVIDERS.GROQ);
    expect(pickModel({ mode: 'report', messageText: 'qualquer coisa' }).provider).toBe(PROVIDERS.GROQ);
    // mesmo com cara de conversa aberta, fora do chat não roteia pro forte
    expect(pickModel({ mode: 'capture', messageText: 'como organizo melhor minha semana?' }).provider).toBe(PROVIDERS.GROQ);
  });

  test('tool mecânica clara vai pra Groq', () => {
    const cases = [
      'cria uma tarefa de pagar o boleto amanhã',
      'conclui a tarefa do relatório',
      'marca o hábito de beber água hoje',
      'reagenda a reunião pra sexta',
      'apaga a nota antiga de mercado'
    ];
    for (const msg of cases) {
      expect(pickModel({ mode: 'chat', messageText: msg }).provider, msg).toBe(PROVIDERS.GROQ);
    }
  });

  test('conversa aberta (modo sócio) vai pro modelo forte', () => {
    const cases = [
      'como você acha que eu devia priorizar meus projetos esse trimestre?',
      'tô me sentindo sobrecarregado com o trabalho, o que você sugere?',
      'me ajuda a pensar na estratégia de preço do meu serviço'
    ];
    for (const msg of cases) {
      expect(pickModel({ mode: 'chat', messageText: msg }).provider, msg).toBe(PROVIDERS.STRONG);
    }
  });

  test('intenção de recuperar histórico vai pro modelo forte', () => {
    const cases = [
      'o que eu tinha decidido sobre o preço do plano?',
      'lembra do que combinamos semana passada?',
      'quando foi que eu concluí a migração do site?'
    ];
    for (const msg of cases) {
      expect(pickModel({ mode: 'chat', messageText: msg }).provider, msg).toBe(PROVIDERS.STRONG);
    }
  });

  test('round após buscar_historico vai pro modelo forte (upgrade meio-de-loop)', () => {
    const choice = pickModel({
      mode: 'chat',
      messageText: 'cria uma tarefa pra revisar isso', // mesmo com verbo de ação...
      executedToolNames: ['buscar_historico']
    });
    expect(choice.provider).toBe(PROVIDERS.STRONG); // ...a síntese pós-busca vence
  });

  test('saudações e acks curtos vão pra Groq', () => {
    for (const msg of ['bom dia', 'oi!', 'valeu', 'blz', 'boa noite']) {
      expect(pickModel({ mode: 'chat', messageText: msg }).provider, msg).toBe(PROVIDERS.GROQ);
    }
  });

  test('default (nada casou) vai pra Groq', () => {
    expect(pickModel({}).provider).toBe(PROVIDERS.GROQ);
    expect(pickModel({ mode: 'chat', messageText: '' }).provider).toBe(PROVIDERS.GROQ);
    expect(pickModel({ mode: 'algum-modo-futuro', messageText: 'texto' }).provider).toBe(PROVIDERS.GROQ);
  });

  test('acentos não mudam a decisão (padrões casam sem diacríticos)', () => {
    expect(pickModel({ mode: 'chat', messageText: 'Crié uma tarefa? não: CRIA a tarefa de pagar água' }).provider).toBe(PROVIDERS.GROQ);
    expect(pickModel({ mode: 'chat', messageText: 'qual era o histórico disso?' }).provider).toBe(PROVIDERS.STRONG);
  });
});
