/* ==========================================================================
   GÊNESIS - STRONG MODEL PROVIDER (CLAUDE VIA ANTHROPIC MESSAGES API)
   ==========================================================================
   Mesma assinatura do provider Groq: chatCompletion(body) recebe e retorna
   o formato OpenAI de chat completions que o loop do chat já usa — este
   módulo é um ADAPTADOR de/para o formato da Anthropic Messages API, pra
   chat.js não saber qual provider está falando. */

import { state } from '../../state.js';

// Modelo forte — troque aqui se preferir custo menor (ex.: 'claude-sonnet-5').
const STRONG_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 16000;
// Modelos fortes pensam antes de responder — timeout generoso, mas finito,
// pra garantir que o fallback pro Groq sempre acontece em tempo útil.
const REQUEST_TIMEOUT_MS = 60000;

// Propriedade interna onde guardamos o conteúdo bruto da Anthropic na
// mensagem retornada (blocos de thinking/tool_use). Ao traduzir o histórico
// de volta, ecoamos esses blocos intactos — obrigatório pro tool calling
// multi-round com thinking adaptativo funcionar.
const RAW_CONTENT_KEY = '_anthropicContent';

export function hasStrongKey() {
  return Boolean(state.anthropicApiKey);
}

// ---- OpenAI -> Anthropic -------------------------------------------------

function translateTools(tools) {
  if (!tools) return undefined;
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));
}

function translateToolChoice(toolChoice) {
  if (!toolChoice || toolChoice === 'auto') return undefined;
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice.type === 'function') return { type: 'tool', name: toolChoice.function.name };
  return undefined;
}

function assistantMessageToContent(msg) {
  // Mensagem que este provider gerou neste turno: ecoa os blocos originais
  // (inclui thinking) exatamente como vieram.
  if (msg[RAW_CONTENT_KEY]) return msg[RAW_CONTENT_KEY];

  const blocks = [];
  if (msg.content) blocks.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* args malformados, segue vazio */ }
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

function translateMessages(messages) {
  let system = '';
  const out = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n\n' : '') + msg.content;
    } else if (msg.role === 'tool') {
      // Resultados de tool viram blocos tool_result numa mensagem de user.
      // Resultados consecutivos (tools paralelas) precisam ir TODOS na mesma
      // mensagem — regra da API da Anthropic.
      const block = { type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    } else if (msg.role === 'assistant') {
      out.push({ role: 'assistant', content: assistantMessageToContent(msg) });
    } else {
      out.push({ role: 'user', content: msg.content });
    }
  }

  return { system, anthropicMessages: out };
}

// ---- Anthropic -> OpenAI -------------------------------------------------

function responseToOpenAI(data) {
  const textParts = [];
  const toolCalls = [];

  for (const block of data.content || []) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) }
      });
    }
    // Blocos de thinking não têm equivalente OpenAI — ficam só no bruto.
  }

  const message = {
    role: 'assistant',
    content: textParts.join('') || null
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  // Guarda o conteúdo bruto pra ecoar intacto se este message voltar no
  // histórico do próximo round (preserva thinking/tool_use).
  Object.defineProperty(message, RAW_CONTENT_KEY, { value: data.content, enumerable: false });

  return { choices: [{ message }] };
}

// ---- Chamada -------------------------------------------------------------

export async function chatCompletion(body) {
  if (!state.anthropicApiKey) {
    throw new Error('Chave do modelo forte não configurada.');
  }

  const { system, anthropicMessages } = translateMessages(body.messages || []);

  const payload = {
    model: STRONG_MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    messages: anthropicMessages
  };
  if (system) payload.system = system;
  const tools = translateTools(body.tools);
  if (tools) payload.tools = tools;
  const toolChoice = translateToolChoice(body.tool_choice);
  if (toolChoice) payload.tool_choice = toolChoice;
  // `temperature` do body é descartado de propósito: modelos 4.7+ rejeitam
  // parâmetros de sampling com 400.

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': state.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      // A chave é do próprio usuário e fica só no navegador dele — mesmo
      // modelo de uso direto do browser que o app já adota com a Groq.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    const err = new Error(`${response.status} ${response.statusText} - ${errText}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();

  // Classificadores podem recusar com HTTP 200 — trata como falha pra o
  // dispatcher cair no Groq em vez de devolver resposta vazia.
  if (data.stop_reason === 'refusal') {
    throw new Error('Modelo forte recusou a solicitação (stop_reason: refusal).');
  }

  return responseToOpenAI(data);
}
