/* ==========================================================================
   GÊNESIS - AGENT CHAT ORCHESTRATION (RENDER, SYSTEM PROMPT & TOOL LOOP)
   ========================================================================== */

import * as localDb from '../db.js';
import { state, getInitialChat, saveApiKey, saveAnthropicApiKey } from '../state.js';
import { parseMarkdown, calculateStreak, getLocalDateString } from '../utils.js';
import { MOOD_LABELS, getMoodTrendForLastDays } from '../features/mood.js';
import { chatCompletion as callGroq } from './providers/groq.js';
import { AGENT_TOOLS, DESTRUCTIVE_TOOLS, describeDestructiveAction, executeFunctionCall } from './tools.js';
import { formatActionSummary, lastActionUndoStack, setLastActionUndoStack, undoLastAction } from './memory.js';

export function saveChat() {
  localDb.saveChatHistory(state.chatHistory).catch(err => console.error('Erro ao salvar conversa:', err));
  renderChat();
}

// Render Chat Messages
export function renderChat() {
  const container = document.getElementById('chat-messages-container');
  container.innerHTML = '';

  state.chatHistory.forEach(msg => {
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-msg ${msg.sender}`;

    msgDiv.innerHTML = `
      <div class="chat-msg-bubble">
        ${parseMarkdown(msg.text)}
      </div>
      <span class="chat-msg-time">${msg.timestamp}</span>
    `;
    container.appendChild(msgDiv);
  });

  // If the most recent turn executed reversible AI actions, offer to undo them
  const lastMsg = state.chatHistory[state.chatHistory.length - 1];
  if (lastMsg && lastMsg.sender === 'agent' && lastActionUndoStack.length > 0) {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'btn-undo-action';
    undoBtn.textContent = '↩️ Desfazer última ação';
    undoBtn.addEventListener('click', undoLastAction);
    container.appendChild(undoBtn);
  }

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

// Show/Hide Typing Indicator
export function showTypingIndicator(show) {
  const container = document.getElementById('chat-messages-container');
  const existing = document.getElementById('chat-typing-indicator');

  if (existing) existing.remove();

  if (show) {
    const indicator = document.createElement('div');
    indicator.id = 'chat-typing-indicator';
    indicator.className = 'chat-msg agent';
    indicator.innerHTML = `
      <div class="chat-msg-bubble">
        <div class="typing-indicator">
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
        </div>
      </div>
    `;
    container.appendChild(indicator);
    container.scrollTop = container.scrollHeight;
  }
}

// Builds the system instruction with fresh workspace context, resent on every turn
// Builds a compact context snapshot + persona for the system prompt. Tasks
// are trimmed to what's actually actionable (overdue/today/next 7 days),
// with everything further out collapsed into a count, to keep this small —
// full task/habit/note management still happens via tools using ids, this
// snapshot just needs enough for the model to reason and reference by id.
function buildSystemInstruction() {
  const todayStr = getLocalDateString(0);
  const in7DaysStr = getLocalDateString(-7);

  const relevantTasks = state.tasks.filter(t => !t.completed && (!t.due || t.due <= in7DaysStr));
  const laterTasksCount = state.tasks.filter(t => !t.completed && t.due && t.due > in7DaysStr).length;
  const completedCount = state.tasks.filter(t => t.completed).length;

  // Compact pipe-delimited rows instead of prose bullets — same information,
  // roughly half the tokens. Header line documents the columns once.
  const tasksText = relevantTasks.map(t => {
    const dueLabel = !t.due ? '-' : t.due < todayStr ? `VENCIDA:${t.due}` : t.due === todayStr ? 'hoje' : t.due;
    return `${t.id}|${t.title}|${t.priority}|${dueLabel}|${t.recurrence || '-'}`;
  }).join('\n') || '(nenhuma tarefa pendente relevante nos próximos 7 dias)';

  const tasksFooter = [
    laterTasksCount > 0 ? `+${laterTasksCount} além de 7d` : null,
    `${completedCount} concluída(s) no total`
  ].filter(Boolean).join('; ');

  const habitsText = state.habits.map(h => {
    const streak = calculateStreak(h.history);
    const atRisk = !h.history[todayStr] && !h.history[getLocalDateString(1)];
    return `${h.id}|${h.name}|streak${streak}${atRisk ? '|RISCO' : ''}`;
  }).join('\n') || '(nenhum hábito cadastrado)';

  const moodEntries = getMoodTrendForLastDays(7);
  const moodAvg = moodEntries.length > 0 ? (moodEntries.reduce((a, b) => a + b, 0) / moodEntries.length) : null;
  const todayMood = state.moods[todayStr];
  const moodText = [
    todayMood !== undefined ? `hoje=${MOOD_LABELS[todayMood]}` : 'hoje ainda não registrado',
    moodAvg !== null ? `média${moodEntries.length}d=${moodAvg.toFixed(1)}` : null
  ].filter(Boolean).join(' | ');

  const recentNotesText = [...state.notes]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map(n => `${n.id}|${n.title}`)
    .join('\n') || '(nenhuma nota cadastrada)';

  const now = new Date();
  const weekdayShort = now.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');

  return `Você é o Gênesis, assistente pessoal de produtividade. Direto, conciso, age em vez de dar sermão — sem enrolação motivacional, sem parabenização vazia. Responda em português.

AGORA: ${weekdayShort} ${now.toLocaleDateString('pt-BR')} ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}

TAREFAS (id|título|prioridade|prazo|recorrência; VENCIDA: = atrasada):
${tasksText}
${tasksFooter}

HÁBITOS (id|nome|streak|obs):
${habitsText}

HUMOR: ${moodText}

NOTAS RECENTES (id|título; use buscar_notas p/ conteúdo):
${recentNotesText}

QUANDO USAR FERRAMENTAS: apenas quando o usuário pedir claramente uma ação (criar/concluir/reagendar/editar/marcar/remover/registrar) ou confirmar uma sugestão que você fez. Use pelo id — não apenas explique.

QUANDO NÃO USAR FERRAMENTAS (responda só com texto):
- Saudações, agradecimentos e conversa casual ("bom dia", "oi", "valeu", "como você está").
- Perguntas sobre os dados ("o que tenho pra hoje?", "como estão meus hábitos?") — responda usando o contexto acima.
- Desabafos ou comentários soltos ("tô cansado", "preciso me organizar melhor") — converse; se achar útil, SUGIRA uma ação e espere confirmação.
- Menção casual a algo a fazer ("qualquer hora preciso lavar o carro") NÃO é pedido — pergunte se quer que registre antes de criar qualquer coisa.

EXEMPLOS:
- "bom dia" → cumprimente e, no máximo, resuma o dia. Nenhuma ferramenta.
- "cria uma tarefa de pagar o boleto amanhã" → criar_tarefa.
- "acho que devia beber mais água" → "Quer que eu crie o hábito 'Beber água'?" — só crie se confirmar.

REGRAS GERAIS: se a intenção ou o id for ambíguo, pergunte antes de agir. Nunca crie itens que o usuário não pediu. Após executar, confirme curto, sem repetir a msg técnica. Leve o humor em conta no tom sem exagerar. Markdown só se ajudar.`;
}

const MAX_TOOL_ROUNDS = 5;

// Call AI (Fetch Groq API with function calling, or fall back to mock responses).
// Runs a full agentic loop: the model can request tools across multiple
// rounds (not just one shot) until it's ready to answer in plain text.
// Returns { text, actions } — `actions` is a compact log of the tools this
// turn actually executed, persisted on the chat message so future turns can
// see what already happened (raw tool_call messages can't be replayed:
// slicing the history would orphan them and the API rejects that).
async function getAgentResponse(userMessage) {
  if (!state.apiKey) {
    return { text: simulateMockResponse(userMessage), actions: [] };
  }

  const actionLog = [];

  try {
    const systemMessage = { role: 'system', content: buildSystemInstruction() };
    const historyMessages = state.chatHistory.slice(-10).map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.sender === 'agent' && Array.isArray(msg.actions) && msg.actions.length > 0
        ? `${msg.text}\n\n[Ações que executei neste turno: ${msg.actions.join('; ')}]`
        : msg.text
    }));

    let messages = [systemMessage, ...historyMessages];
    const executedToolNames = [];
    const turnUndoStack = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await callGroq({ messages, tools: AGENT_TOOLS, tool_choice: 'auto', temperature: 0.2 });
      const message = response.choices?.[0]?.message;
      const toolCalls = message?.tool_calls || [];

      if (toolCalls.length === 0) {
        if (turnUndoStack.length > 0) setLastActionUndoStack(turnUndoStack);
        const summary = formatActionSummary(executedToolNames);
        const text = message?.content || '';
        const finalText = (summary && text) ? `${summary}\n\n${text}`
          : (summary || text || 'Desculpe, não consegui gerar uma resposta agora.');
        return { text: finalText, actions: actionLog };
      }

      messages.push(message);

      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* malformed args, use empty */ }

        // Destructive tools always get a native confirm() first, regardless
        // of how the model phrased its intent — enforced in code, not prompt.
        if (DESTRUCTIVE_TOOLS.has(tc.function.name)) {
          const description = describeDestructiveAction(tc.function.name, args);
          const confirmed = description ? confirm(`A IA quer ${description}. Confirmar?`) : false;
          if (!confirmed) {
            actionLog.push(`${tc.function.name}: cancelada — o usuário não confirmou`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ status: 'cancelled', message: 'O usuário não confirmou esta ação. Não tente novamente sem perguntar antes.' })
            });
            continue;
          }
        }

        const result = await executeFunctionCall(tc.function.name, args);
        if (result.status === 'ok') {
          executedToolNames.push(tc.function.name);
          if (result.undo) turnUndoStack.push(result.undo);
          if (result.message) actionLog.push(`${tc.function.name}: ${result.message}`);
        }
        // The `undo` closure itself isn't meaningful to the model — strip it
        // before sending the result back as the tool's return value.
        const { undo, ...resultForModel } = result;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(resultForModel) });
      }
    }

    if (turnUndoStack.length > 0) setLastActionUndoStack(turnUndoStack);
    const summary = formatActionSummary(executedToolNames);
    return {
      text: summary ? `${summary}\n\n(Muitas etapas nessa solicitação — se faltou algo, me chama de novo.)` : 'Não consegui concluir essa solicitação em tempo hábil.',
      actions: actionLog
    };
  } catch (err) {
    console.error(err);
    return {
      text: `❌ **Erro de Conexão com a IA:** Não consegui conectar à API do Groq. Verifique sua conexão ou se a sua chave de API é válida.\n\n*Detalhes do Erro:* ${err.message}`,
      actions: actionLog
    };
  }
}

// Simulate smart responses if no API Key
function simulateMockResponse(msg) {
  const text = msg.toLowerCase();

  // Custom response logic
  if (text.includes('planejar') || text.includes('dia') || text.includes('hoje')) {
    const pendingTasks = state.tasks.filter(t => !t.completed);
    let taskList = pendingTasks.map(t => `- **${t.title}** (Prioridade: ${t.priority})`).join('\n');
    if (!taskList) taskList = '- *Nenhuma tarefa pendente no momento! Crie uma no painel ao lado.*';

    return `📅 **Planejamento do Dia (Modo Simulado)**\n\nAqui está uma sugestão com base nas suas tarefas atuais:\n\n1. **Foco Principal (Manhã):** Comece atacando as tarefas de alta prioridade. Seus períodos de maior energia devem ser reservados para isso.\n2. **Organização:**\n${taskList}\n3. **Cuidado Pessoal:** Lembre-se de checar seus hábitos hoje (ex: Beber água).\n\n*Nota:* Para obter um planejamento avançado de IA integrado a este chat, insira sua **API Key da Groq** clicando no botão no topo!`;
  }

  if (text.includes('tarefa') || text.includes('urgente') || text.includes('pendente')) {
    const pending = state.tasks.filter(t => !t.completed);
    if (pending.length === 0) {
      return `Não há tarefas pendentes! Você está livre hoje. Bom trabalho! 🎉`;
    }
    let list = pending.map(t => `- [ ] ${t.title} (${t.priority})`).join('\n');
    return `⚠️ **Tarefas Pendentes no Painel:**\n\n${list}\n\nVocê pode concluí-las clicando na caixa de seleção ao lado de cada uma!`;
  }

  if (text.includes('hábito') || text.includes('habito') || text.includes('agua') || text.includes('água')) {
    return `💧 **Acompanhamento de Hábitos:**\n\nConstruir hábitos diários sólidos é a chave para o sucesso a longo prazo. No seu painel de hábitos ao lado, você pode rastrear seu progresso dos últimos 7 dias. Seu streak atual será atualizado automaticamente!\n\nQuer criar um novo hábito? Basta usar o botão **"Adicionar Hábito"** acima.`;
  }

  if (text.includes('nota') || text.includes('escrever') || text.includes('anota')) {
    return `📝 **Bloco de Notas:**\n\nO bloco de notas à direita permite anotações completas suportando **Markdown**!\n- Crie uma nota clicando em **"Nova Nota"**.\n- Digite seu conteúdo.\n- Clique em **"Preview"** para visualizar como ficará renderizado (títulos, listas, etc.).\n\nTodas as notas são salvas localmente instantaneamente.`;
  }

  return `🤖 **Olá! Eu sou o Gênesis.**\n\nEstou rodando no *Modo Simulado*. Consigo interagir com suas tarefas, hábitos e notas locais. \n\n**O que deseja fazer?**\n- Digite "planejar meu dia" para ver sugestões.\n- Digite "tarefas" para listar o que tem pendente.\n\n*Recomendado:* Configure sua **API Key da Groq** na barra superior para conversar comigo livremente e ter respostas inteligentes baseadas no seu contexto!`;
}

// Handle sending messages in the UI
export async function handleSendMessage(messageText) {
  if (!messageText.trim()) return;

  // Append user message
  state.chatHistory.push({
    sender: 'user',
    text: messageText,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  });
  saveChat();

  // Show typing indicator
  showTypingIndicator(true);

  // Get response
  const agentResponse = await getAgentResponse(messageText);

  // Hide typing indicator
  showTypingIndicator(false);

  // Append agent message, carrying the executed-actions log so future turns
  // can remind the model of what it already did (see getAgentResponse).
  const agentMsg = {
    sender: 'agent',
    text: agentResponse.text,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
  if (agentResponse.actions.length > 0) agentMsg.actions = agentResponse.actions;
  state.chatHistory.push(agentMsg);
  saveChat();
}

// Wires the chat form, suggested prompts, clear-chat button and the API key modal
export function initChatUI() {
  // Chat submit form
  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const msg = input.value;
    input.value = '';
    handleSendMessage(msg);
  });

  // Suggested Prompts
  document.querySelectorAll('.btn-suggestion').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const prompt = e.currentTarget.getAttribute('data-prompt');
      handleSendMessage(prompt);
    });
  });

  // Clear Chat
  document.getElementById('btn-clear-chat').addEventListener('click', () => {
    if (confirm('Tem certeza de que deseja limpar o histórico de conversas?')) {
      state.chatHistory = getInitialChat();
      saveChat();
    }
  });

  // API Modal Toggles
  const apiModal = document.getElementById('api-modal');
  const apiKeyInput = document.getElementById('api-key-input');
  const anthropicKeyInput = document.getElementById('anthropic-key-input');

  document.getElementById('btn-api-config').addEventListener('click', () => {
    apiKeyInput.value = state.apiKey;
    anthropicKeyInput.value = state.anthropicApiKey;
    apiModal.classList.remove('hidden');
  });

  document.getElementById('btn-close-modal').addEventListener('click', () => {
    apiModal.classList.add('hidden');
  });

  document.getElementById('btn-save-api-key').addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    saveApiKey(key);
    saveAnthropicApiKey(anthropicKeyInput.value.trim());
    apiModal.classList.add('hidden');

    // Notify in chat
    state.chatHistory.push({
      sender: 'agent',
      text: key ? '✅ **API Key configurada com sucesso!** Agora minhas respostas serão inteligentes e personalizadas de verdade!' : '⚠️ **API Key removida.** Retornei ao modo de simulação local.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    saveChat();
  });

  document.getElementById('btn-remove-api-key').addEventListener('click', () => {
    saveApiKey('');
    saveAnthropicApiKey('');
    apiModal.classList.add('hidden');

    state.chatHistory.push({
      sender: 'agent',
      text: '⚠️ **API Key removida.** Retornei ao modo de simulação local.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    saveChat();
  });
}
