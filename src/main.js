/* ==========================================================================
   GÊNESIS - CORE JAVASCRIPT & STATE MANAGEMENT
   ========================================================================== */

import './style.css';
import * as localDb from './db.js';
import Fuse from 'fuse.js';
import {
  initClock,
  formatDateLocal,
  getLocalDateString,
  RECURRENCE_LABELS,
  computeNextDueDate,
  parseMarkdown,
  calculateStreak,
  escapeHtml,
  stripDiacritics
} from './utils.js';
import {
  STATE_KEYS,
  state,
  loadState,
  saveApiKey,
  getInitialChat,
  updateStats,
  updateAgentStatus
} from './state.js';
import {
  googleTokenClient,
  initGoogleCalendarClient,
  showCalendarStatus,
  syncTasksToGoogleCalendar,
  deleteGoogleCalendarEvent,
  updateGoogleCalendarEventDate
} from './integrations/googleCalendar.js';
import {
  saveTasks,
  renderTasks,
  getTaskCreatedAt,
  spawnNextRecurrence,
  initTasksUI
} from './features/tasks.js';
import { saveHabits, renderHabits, renderHabitsHeader, initHabitsUI } from './features/habits.js';
import { callGroq } from './agent/groq.js';
import { queueCloudPush, initCloudSync } from './integrations/cloudSync.js';

// Applied immediately at module load (before the rest of init) to avoid a
// flash of the wrong theme while the page loads.
document.documentElement.setAttribute('data-theme', localStorage.getItem(STATE_KEYS.THEME) || 'dark');

// Save helpers — the IndexedDB write happens in the background (fire-and-
// forget with error logging); render + stats update immediately from the
// in-memory state so the UI never waits on the write.
function saveMoods() {
  localDb.saveMoods(state.moods).catch(err => console.error('Erro ao salvar humor:', err));
  renderMoodTracker();
  queueCloudPush();
}

function saveNotes() {
  localDb.saveNotes(state.notes).catch(err => console.error('Erro ao salvar notas:', err));
  renderNotes();
  updateStats();
  queueCloudPush();
}

function saveChat() {
  localDb.saveChatHistory(state.chatHistory).catch(err => console.error('Erro ao salvar conversa:', err));
  renderChat();
}

// ==========================================================================
// 4. RENDERING & DATA DISPLAY
// ==========================================================================

// Highlights today's selected mood button, if any
function renderMoodTracker() {
  const todayStr = getLocalDateString(0);
  const selected = state.moods[todayStr];
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.getAttribute('data-mood')) === selected);
  });
}

// Notes Sidebar List Rendering
function renderNotes() {
  const container = document.getElementById('notes-list-container');
  container.innerHTML = '';

  if (state.notes.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;">Sem notas salvas.</div>';
    showNotePane(null);
    return;
  }

  // Sort notes by updated date (most recent first)
  const sortedNotes = [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt);

  sortedNotes.forEach(note => {
    const item = document.createElement('div');
    item.className = `note-item ${state.activeNoteId === note.id ? 'active' : ''}`;
    
    const plainExcerpt = note.body ? note.body.replace(/[#*`>-]/g, '').substring(0, 40) : 'Sem conteúdo extra';
    const formattedDate = new Date(note.updatedAt).toLocaleDateString('pt-BR', {day: 'numeric', month: 'short', hour: '2-digit', minute:'2-digit'});

    item.innerHTML = `
      <span class="note-item-title">${escapeHtml(note.title || 'Sem Título')}</span>
      <span class="note-item-excerpt">${escapeHtml(plainExcerpt)}</span>
      <span class="note-item-date">${formattedDate}</span>
    `;

    item.addEventListener('click', () => {
      state.activeNoteId = note.id;
      renderNotes();
      showNotePane(note);
    });

    container.appendChild(item);
  });

  // Keep editor active if activeNoteId exists
  const activeNote = state.notes.find(n => n.id === state.activeNoteId);
  if (activeNote) {
    showNotePane(activeNote);
  } else {
    // If activeNote doesn't exist but notes exist, select first note
    state.activeNoteId = sortedNotes[0].id;
    showNotePane(sortedNotes[0]);
    renderNotes();
  }
}

// Toggle Note Editor pane or Empty state pane
function showNotePane(note) {
  const editorPane = document.getElementById('note-editor-pane');
  const emptyPane = document.getElementById('note-empty-pane');

  if (!note) {
    editorPane.classList.add('hidden');
    emptyPane.classList.remove('hidden');
    return;
  }

  editorPane.classList.remove('hidden');
  emptyPane.classList.add('hidden');

  // Fill in inputs if not currently focused to prevent losing cursor position
  const titleInput = document.getElementById('note-title-input');
  const bodyInput = document.getElementById('note-body-input');
  
  if (document.activeElement !== titleInput) titleInput.value = note.title;
  if (document.activeElement !== bodyInput) bodyInput.value = note.body;

  // Render preview if open
  const previewContainer = document.getElementById('note-body-preview');
  if (!previewContainer.classList.contains('hidden')) {
    previewContainer.innerHTML = parseMarkdown(note.body);
  }
}

// Render Chat Messages
function renderChat() {
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
function showTypingIndicator(show) {
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

// ==========================================================================
// 5. INTERACTIVE AGENT LOGIC (SIMULATED OR GROQ API)
// ==========================================================================

// Declares the actions the model is allowed to trigger directly on the user's workspace,
// in OpenAI-compatible tool-calling format (used by Groq's chat completions API).
// Tools take real IDs (exposed to the model via buildSystemInstruction's
// context snapshot) instead of fuzzy title/name matching — reliable even
// when two items have very similar names.
const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'criar_tarefa',
      description: 'Cria uma nova tarefa no painel do usuário.',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título da tarefa' },
          prioridade: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Prioridade da tarefa (padrão: medium)' },
          prazo: { type: 'string', description: 'Prazo no formato YYYY-MM-DD, se mencionado' },
          recorrencia: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Se a tarefa deve se repetir automaticamente após concluída (omita se não for recorrente)' }
        },
        required: ['titulo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'concluir_tarefa',
      description: 'Marca uma tarefa existente como concluída (ou reabre, se especificado), pelo id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id da tarefa' },
          concluido: { type: 'boolean', description: 'true para concluir, false para reabrir (padrão: true)' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reagendar_tarefa',
      description: 'Move o prazo de uma tarefa existente para uma nova data, pelo id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id da tarefa' },
          novo_prazo: { type: 'string', description: 'Novo prazo no formato YYYY-MM-DD (envie vazio para remover o prazo)' }
        },
        required: ['id', 'novo_prazo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'editar_tarefa',
      description: 'Edita título, prioridade, prazo e/ou recorrência de uma tarefa existente, pelo id. Envie apenas os campos que quer alterar.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id da tarefa a editar' },
          titulo: { type: 'string', description: 'Novo título, se for alterar' },
          prioridade: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Nova prioridade, se for alterar' },
          prazo: { type: 'string', description: 'Novo prazo no formato YYYY-MM-DD, se for alterar (envie vazio para remover)' },
          recorrencia: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'], description: 'Nova recorrência, se for alterar ("none" para parar de repetir)' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deletar_tarefa',
      description: 'Remove uma tarefa do painel, pelo id. Ação destrutiva — o usuário confirma antes de executar.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Id da tarefa' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'criar_habito',
      description: 'Cria um novo hábito para ser rastreado diariamente.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome do hábito' },
          frequencia: { type: 'string', description: 'Frequência desejada em texto livre (ex: "todo dia", "3x por semana"), apenas informativo por enquanto' }
        },
        required: ['nome']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'marcar_habito',
      description: 'Marca ou desmarca um hábito como concluído numa data, pelo id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id do hábito' },
          data: { type: 'string', description: 'Data no formato YYYY-MM-DD (padrão: hoje)' },
          concluido: { type: 'boolean', description: 'true para marcar como feito, false para desmarcar (padrão: true)' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deletar_habito',
      description: 'Remove um hábito rastreado, pelo id. Ação destrutiva — o usuário confirma antes de executar.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Id do hábito' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'criar_nota',
      description: 'Cria uma nova nota/anotação com título e conteúdo (Markdown suportado).',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título da nota' },
          conteudo: { type: 'string', description: 'Conteúdo da nota em Markdown' }
        },
        required: ['titulo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deletar_nota',
      description: 'Remove uma nota existente, pelo id. Ação destrutiva — o usuário confirma antes de executar.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Id da nota' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'buscar_notas',
      description: 'Busca notas por palavra-chave no título ou conteúdo. Use antes de responder perguntas sobre o conteúdo de notas específicas.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Termo de busca' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'registrar_humor',
      description: 'Registra o humor do usuário numa data, numa escala de 1 (péssimo) a 5 (ótimo).',
      parameters: {
        type: 'object',
        properties: {
          valor: { type: 'integer', minimum: 1, maximum: 5, description: '1=péssimo, 2=ruim, 3=neutro, 4=bom, 5=ótimo' },
          data: { type: 'string', description: 'Data no formato YYYY-MM-DD (padrão: hoje)' }
        },
        required: ['valor']
      }
    }
  }
];

// Tool calls that mutate destructively — the app always asks for explicit
// confirmation in a native dialog before executing these, regardless of how
// confident the model is. This is enforced in code, not just prompted for,
// so it can't be talked around by a persuasive user message.
const DESTRUCTIVE_TOOLS = new Set(['deletar_tarefa', 'deletar_habito', 'deletar_nota']);

// Resolves a friendly description of what a destructive call is about to do,
// so the confirmation dialog names the actual item instead of a bare id.
function describeDestructiveAction(name, args) {
  if (name === 'deletar_tarefa') {
    const task = state.tasks.find(t => t.id === args.id);
    return task ? `excluir a tarefa "${task.title}"` : null;
  }
  if (name === 'deletar_habito') {
    const habit = state.habits.find(h => h.id === args.id);
    return habit ? `excluir o hábito "${habit.name}"` : null;
  }
  if (name === 'deletar_nota') {
    const note = state.notes.find(n => n.id === args.id);
    return note ? `excluir a nota "${note.title}"` : null;
  }
  return null;
}

// Fuzzy search over note title + body (typo-tolerant, no exact substring
// needed). Rebuilt fresh per search — at personal-note volumes this is
// cheap enough that caching the index isn't worth the invalidation logic.
function searchNotesFuzzy(query) {
  const q = (query || '').trim();
  if (!q) return [];

  const fuse = new Fuse(state.notes, {
    keys: ['title', 'body'],
    includeMatches: true,
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 2
  });

  return fuse.search(q).map(result => ({ note: result.item, matches: result.matches || [] }));
}

// Used by the buscar_notas tool — just needs the notes, ranked by relevance
function searchNotes(query) {
  return searchNotesFuzzy(query).map(r => r.note);
}

// Builds a highlighted snippet around the first body match (or a plain lead-in
// if only the title matched), for the search results UI.
function buildHighlightedSnippet(note, matches, maxLen = 140) {
  const body = note.body || '';
  const bodyMatch = matches.find(m => m.key === 'body' && m.indices && m.indices.length > 0);

  if (!bodyMatch) {
    return escapeHtml(body.slice(0, maxLen)) + (body.length > maxLen ? '…' : '');
  }

  const [start, end] = bodyMatch.indices[0];
  const windowStart = Math.max(0, start - 40);
  const windowEnd = Math.min(body.length, end + 1 + 60);

  const before = escapeHtml(body.slice(windowStart, start));
  const matched = escapeHtml(body.slice(start, end + 1));
  const after = escapeHtml(body.slice(end + 1, windowEnd));

  return `${windowStart > 0 ? '…' : ''}${before}<mark>${matched}</mark>${after}${windowEnd < body.length ? '…' : ''}`;
}

// Executes a single function call requested by the model against local state.
// Returns { status, message, undo? } — `undo`, when present, is an async
// closure that reverses exactly this mutation (used by the "desfazer última
// ação" chat button). Unknown ids are reported back as a normal error result
// so the model can recover (e.g. ask the user to clarify) instead of the
// whole tool loop breaking.
async function executeFunctionCall(name, args) {
  switch (name) {
    case 'criar_tarefa': {
      const newTask = {
        id: 'task_' + Date.now(),
        title: args.titulo,
        priority: args.prioridade || 'medium',
        due: args.prazo || '',
        recurrence: args.recorrencia || '',
        completed: false,
        createdAt: Date.now(),
        rescheduleCount: 0
      };
      state.tasks.push(newTask);
      saveTasks();
      return {
        status: 'ok',
        message: `Tarefa "${newTask.title}" adicionada.`,
        undo: () => { state.tasks = state.tasks.filter(t => t.id !== newTask.id); saveTasks(); }
      };
    }
    case 'concluir_tarefa': {
      const task = state.tasks.find(t => t.id === args.id);
      if (!task) return { status: 'error', message: `Nenhuma tarefa encontrada com o id "${args.id}".` };

      const previousCompleted = task.completed;
      const previousCompletedAt = task.completedAt;
      task.completed = args.concluido !== undefined ? !!args.concluido : true;
      task.completedAt = task.completed ? Date.now() : undefined;

      let spawnedTask = null;
      if (task.completed && task.recurrence) {
        spawnNextRecurrence(task);
        spawnedTask = state.tasks[state.tasks.length - 1];
      }
      saveTasks();

      if (task.completed && task.gcalEventId) {
        const eventId = task.gcalEventId;
        task.gcalEventId = undefined;
        await deleteGoogleCalendarEvent(eventId);
        saveTasks();
      }

      return {
        status: 'ok',
        message: `Tarefa "${task.title}" marcada como ${task.completed ? 'concluída' : 'pendente'}.`,
        undo: () => {
          task.completed = previousCompleted;
          task.completedAt = previousCompletedAt;
          if (spawnedTask) state.tasks = state.tasks.filter(t => t.id !== spawnedTask.id);
          saveTasks();
        }
      };
    }
    case 'reagendar_tarefa': {
      const task = state.tasks.find(t => t.id === args.id);
      if (!task) return { status: 'error', message: `Nenhuma tarefa encontrada com o id "${args.id}".` };

      const previousDue = task.due;
      task.due = args.novo_prazo || '';
      task.rescheduleCount = (task.rescheduleCount || 0) + 1;
      saveTasks();

      if (task.gcalEventId) {
        if (task.due) await updateGoogleCalendarEventDate(task.gcalEventId, task.due);
        else { const eventId = task.gcalEventId; task.gcalEventId = undefined; saveTasks(); await deleteGoogleCalendarEvent(eventId); }
      }

      return {
        status: 'ok',
        message: `Tarefa "${task.title}" reagendada para ${task.due || 'sem prazo'}.`,
        undo: () => { task.due = previousDue; task.rescheduleCount = Math.max(0, (task.rescheduleCount || 0) - 1); saveTasks(); }
      };
    }
    case 'editar_tarefa': {
      const task = state.tasks.find(t => t.id === args.id);
      if (!task) return { status: 'error', message: `Nenhuma tarefa encontrada com o id "${args.id}".` };

      const previous = { title: task.title, priority: task.priority, due: task.due, recurrence: task.recurrence, rescheduleCount: task.rescheduleCount || 0 };
      const dueChanged = args.prazo !== undefined && args.prazo !== task.due;

      if (args.titulo) task.title = args.titulo;
      if (args.prioridade) task.priority = args.prioridade;
      if (args.prazo !== undefined) task.due = args.prazo;
      if (args.recorrencia !== undefined) task.recurrence = args.recorrencia === 'none' ? '' : args.recorrencia;
      if (dueChanged) task.rescheduleCount = (task.rescheduleCount || 0) + 1;
      saveTasks();

      if (dueChanged && task.gcalEventId) {
        if (task.due) await updateGoogleCalendarEventDate(task.gcalEventId, task.due);
        else { const eventId = task.gcalEventId; task.gcalEventId = undefined; saveTasks(); await deleteGoogleCalendarEvent(eventId); }
      }

      return {
        status: 'ok',
        message: `Tarefa "${task.title}" atualizada.`,
        undo: () => { Object.assign(task, previous); saveTasks(); }
      };
    }
    case 'deletar_tarefa': {
      const task = state.tasks.find(t => t.id === args.id);
      if (!task) return { status: 'error', message: `Nenhuma tarefa encontrada com o id "${args.id}".` };
      const eventId = task.gcalEventId;
      state.tasks = state.tasks.filter(t => t.id !== task.id);
      saveTasks();
      if (eventId) await deleteGoogleCalendarEvent(eventId);
      return {
        status: 'ok',
        message: `Tarefa "${task.title}" removida.`,
        undo: () => { state.tasks.push(task); saveTasks(); }
      };
    }
    case 'criar_habito': {
      const newHabit = { id: 'habit_' + Date.now(), name: args.nome, history: {} };
      state.habits.push(newHabit);
      saveHabits();
      return {
        status: 'ok',
        message: `Hábito "${newHabit.name}" criado.`,
        undo: () => { state.habits = state.habits.filter(h => h.id !== newHabit.id); saveHabits(); }
      };
    }
    case 'marcar_habito': {
      const habit = state.habits.find(h => h.id === args.id);
      if (!habit) return { status: 'error', message: `Nenhum hábito encontrado com o id "${args.id}".` };

      const date = args.data || getLocalDateString(0);
      const previousValue = habit.history[date];
      const completed = args.concluido !== undefined ? !!args.concluido : true;
      habit.history[date] = completed;
      saveHabits();

      return {
        status: 'ok',
        message: `Hábito "${habit.name}" ${completed ? 'marcado como feito' : 'desmarcado'} em ${date}.`,
        undo: () => {
          if (previousValue === undefined) delete habit.history[date];
          else habit.history[date] = previousValue;
          saveHabits();
        }
      };
    }
    case 'deletar_habito': {
      const habit = state.habits.find(h => h.id === args.id);
      if (!habit) return { status: 'error', message: `Nenhum hábito encontrado com o id "${args.id}".` };
      state.habits = state.habits.filter(h => h.id !== habit.id);
      saveHabits();
      return {
        status: 'ok',
        message: `Hábito "${habit.name}" removido.`,
        undo: () => { state.habits.push(habit); saveHabits(); }
      };
    }
    case 'criar_nota': {
      const newNote = { id: 'note_' + Date.now(), title: args.titulo, body: args.conteudo || '', updatedAt: Date.now() };
      state.notes.push(newNote);
      state.activeNoteId = newNote.id;
      saveNotes();
      return {
        status: 'ok',
        message: `Nota "${newNote.title}" criada.`,
        undo: () => { state.notes = state.notes.filter(n => n.id !== newNote.id); saveNotes(); }
      };
    }
    case 'deletar_nota': {
      const note = state.notes.find(n => n.id === args.id);
      if (!note) return { status: 'error', message: `Nenhuma nota encontrada com o id "${args.id}".` };
      state.notes = state.notes.filter(n => n.id !== note.id);
      if (state.activeNoteId === note.id) {
        state.activeNoteId = state.notes.length > 0 ? state.notes[0].id : null;
      }
      saveNotes();
      return {
        status: 'ok',
        message: `Nota "${note.title}" removida.`,
        undo: () => { state.notes.push(note); saveNotes(); }
      };
    }
    case 'buscar_notas': {
      const matches = searchNotes(args.query);
      if (matches.length === 0) {
        return { status: 'ok', message: `Nenhuma nota encontrada para "${args.query}".`, results: [] };
      }
      return {
        status: 'ok',
        message: `${matches.length} nota(s) encontrada(s).`,
        results: matches.map(n => ({ id: n.id, titulo: n.title, trecho: (n.body || '').slice(0, 200) }))
      };
    }
    case 'registrar_humor': {
      const date = args.data || getLocalDateString(0);
      const value = Math.max(1, Math.min(5, Math.round(args.valor)));
      const previousValue = state.moods[date];
      state.moods[date] = value;
      saveMoods();
      return {
        status: 'ok',
        message: `Humor de ${date} registrado como "${MOOD_LABELS[value]}".`,
        undo: () => {
          if (previousValue === undefined) delete state.moods[date];
          else state.moods[date] = previousValue;
          saveMoods();
        }
      };
    }
    default:
      return { status: 'error', message: `Função desconhecida: ${name}` };
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

// Compact tallies for the "✓ 3 tarefas criadas, 1 reagendada" summary line
const ACTION_SUMMARY_LABELS = {
  criar_tarefa: n => `${n} tarefa${n > 1 ? 's' : ''} criada${n > 1 ? 's' : ''}`,
  concluir_tarefa: n => `${n} tarefa${n > 1 ? 's' : ''} concluída${n > 1 ? 's' : ''}`,
  reagendar_tarefa: n => `${n} tarefa${n > 1 ? 's' : ''} reagendada${n > 1 ? 's' : ''}`,
  editar_tarefa: n => `${n} tarefa${n > 1 ? 's' : ''} editada${n > 1 ? 's' : ''}`,
  deletar_tarefa: n => `${n} tarefa${n > 1 ? 's' : ''} excluída${n > 1 ? 's' : ''}`,
  criar_habito: n => `${n} hábito${n > 1 ? 's' : ''} criado${n > 1 ? 's' : ''}`,
  marcar_habito: n => `${n} hábito${n > 1 ? 's' : ''} marcado${n > 1 ? 's' : ''}`,
  deletar_habito: n => `${n} hábito${n > 1 ? 's' : ''} excluído${n > 1 ? 's' : ''}`,
  criar_nota: n => `${n} nota${n > 1 ? 's' : ''} criada${n > 1 ? 's' : ''}`,
  deletar_nota: n => `${n} nota${n > 1 ? 's' : ''} excluída${n > 1 ? 's' : ''}`,
  registrar_humor: () => 'humor registrado'
};

function formatActionSummary(executedToolNames) {
  const counts = {};
  for (const name of executedToolNames) counts[name] = (counts[name] || 0) + 1;
  const parts = Object.entries(counts)
    .filter(([name]) => ACTION_SUMMARY_LABELS[name])
    .map(([name, n]) => ACTION_SUMMARY_LABELS[name](n));
  return parts.length > 0 ? `✓ ${parts.join(', ')}` : '';
}

// Holds the undo closures for the most recently executed batch of AI
// actions (a single chat turn may run several tool calls) — single level,
// not a full history, matching "desfazer a última ação".
let lastActionUndoStack = [];

async function undoLastAction() {
  if (lastActionUndoStack.length === 0) return;
  const stack = lastActionUndoStack;
  lastActionUndoStack = [];

  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      await stack[i]();
    } catch (err) {
      console.error('Erro ao desfazer ação:', err);
    }
  }

  state.chatHistory.push({
    sender: 'agent',
    text: '↩️ Última ação desfeita.',
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  });
  saveChat();
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
        if (turnUndoStack.length > 0) lastActionUndoStack = turnUndoStack;
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

    if (turnUndoStack.length > 0) lastActionUndoStack = turnUndoStack;
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
async function handleSendMessage(messageText) {
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

// ==========================================================================
// 6. WEEKLY REPORT
// ==========================================================================

const MOOD_EMOJIS = { 1: '😞', 2: '😕', 3: '😐', 4: '🙂', 5: '🤩' };
const MOOD_LABELS = { 1: 'péssimo', 2: 'ruim', 3: 'neutro', 4: 'bom', 5: 'ótimo' };

function getMoodTrendForLastDays(days) {
  const entries = [];
  for (let i = days - 1; i >= 0; i--) {
    const dateStr = getLocalDateString(i);
    if (state.moods[dateStr] !== undefined) entries.push(state.moods[dateStr]);
  }
  return entries;
}

const WEEKDAY_LABELS_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MIN_CORRELATION_SAMPLE_DAYS = 5;
const ZOMBIE_RESCHEDULE_THRESHOLD = 3;
const ZOMBIE_AGE_DAYS_THRESHOLD = 14;

function getTasksCompletedOnDate(dateStr) {
  return state.tasks.filter(t => t.completed && t.completedAt && formatDateLocal(new Date(t.completedAt)) === dateStr).length;
}

// For each habit, compares avg. tasks completed on days it was done vs. days
// it wasn't, over the last month. Only speaks up when both groups have a
// reasonable sample (brief: "amostra mínima razoável, ≥5 dias").
function computeHabitTaskCorrelations(lookbackDays = 30) {
  const results = [];
  for (const habit of state.habits) {
    const doneDays = [];
    const notDoneDays = [];
    for (let i = 0; i < lookbackDays; i++) {
      const dateStr = getLocalDateString(i);
      const tasksThatDay = getTasksCompletedOnDate(dateStr);
      (habit.history[dateStr] ? doneDays : notDoneDays).push(tasksThatDay);
    }
    if (doneDays.length < MIN_CORRELATION_SAMPLE_DAYS || notDoneDays.length < MIN_CORRELATION_SAMPLE_DAYS) continue;

    const avgDone = doneDays.reduce((a, b) => a + b, 0) / doneDays.length;
    const avgNotDone = notDoneDays.reduce((a, b) => a + b, 0) / notDoneDays.length;
    if (avgDone === avgNotDone) continue;

    const percentDiff = avgNotDone === 0 ? null : Math.round(((avgDone - avgNotDone) / avgNotDone) * 100);
    results.push({ habit, avgDone, avgNotDone, percentDiff, sampleDone: doneDays.length, sampleNotDone: notDoneDays.length });
  }
  results.sort((a, b) => Math.abs(b.avgDone - b.avgNotDone) - Math.abs(a.avgDone - a.avgNotDone));
  return results;
}

// Tasks that have been rescheduled 3+ times or have sat pending for 14+ days
function getZombieTasks() {
  return state.tasks.filter(t => {
    if (t.completed) return false;
    const ageDays = (Date.now() - getTaskCreatedAt(t)) / 86400000;
    return (t.rescheduleCount || 0) >= ZOMBIE_RESCHEDULE_THRESHOLD || ageDays >= ZOMBIE_AGE_DAYS_THRESHOLD;
  });
}

// Aggregate habit completion rate per weekday across all habits (last 14
// days) — missing entries count as "not done", same convention used
// elsewhere in the app (e.g. habit reminders).
function getHabitRateByWeekday(lookbackDays = 14) {
  if (state.habits.length === 0) return [];
  const totals = new Array(7).fill(0);
  const completedCounts = new Array(7).fill(0);

  for (let i = 0; i < lookbackDays; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = formatDateLocal(d);
    for (const habit of state.habits) {
      totals[d.getDay()]++;
      if (habit.history[dateStr]) completedCounts[d.getDay()]++;
    }
  }

  return WEEKDAY_LABELS_SHORT.map((label, i) => ({
    label,
    rate: totals[i] > 0 ? Math.round((completedCounts[i] / totals[i]) * 100) : null
  }));
}

function getCreatedVsCompletedThisWeek() {
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  const created = state.tasks.filter(t => getTaskCreatedAt(t) >= sevenDaysAgo).length;
  const completed = state.tasks.filter(t => t.completed && t.completedAt && t.completedAt >= sevenDaysAgo).length;
  return { created, completed };
}

function buildWeeklyReport() {
  const tasksCompletedThisWeek = state.tasks.filter(t => t.completed).length;
  const totalTasks = state.tasks.length;

  const habitRates = state.habits.map(h => {
    let completed = 0;
    for (let i = 0; i < 7; i++) {
      if (h.history[getLocalDateString(i)]) completed++;
    }
    return completed / 7;
  });
  const avgHabitRate = habitRates.length > 0
    ? Math.round((habitRates.reduce((a, b) => a + b, 0) / habitRates.length) * 100)
    : 0;

  const bestStreak = state.habits.reduce((max, h) => Math.max(max, calculateStreak(h.history)), 0);
  const notesThisWeek = state.notes.filter(n => Date.now() - n.updatedAt <= 7 * 24 * 3600 * 1000).length;

  const moodEntries = getMoodTrendForLastDays(7);
  const avgMood = moodEntries.length > 0 ? moodEntries.reduce((a, b) => a + b, 0) / moodEntries.length : null;
  const avgMoodRounded = avgMood !== null ? Math.round(avgMood) : null;

  const correlations = computeHabitTaskCorrelations();
  const zombieTasks = getZombieTasks();
  const weekdayRates = getHabitRateByWeekday();
  const createdVsCompleted = getCreatedVsCompletedThisWeek();

  return {
    tasksCompletedThisWeek, totalTasks, avgHabitRate, bestStreak, notesThisWeek,
    avgMood, avgMoodRounded, moodEntries, correlations, zombieTasks, weekdayRates, createdVsCompleted
  };
}

// Deterministic fallback paragraph (used without an API key, or if the AI call fails)
function buildFallbackHighlight(report) {
  let highlight;
  if (report.totalTasks === 0 && state.habits.length === 0) {
    highlight = 'Comece adicionando algumas tarefas e hábitos para o Gênesis acompanhar sua evolução semanal.';
  } else if (report.avgHabitRate >= 70 && report.tasksCompletedThisWeek === report.totalTasks && report.totalTasks > 0) {
    highlight = `Semana forte: todas as tarefas concluídas e ${report.avgHabitRate}% de consistência nos hábitos.`;
  } else if (report.avgHabitRate >= 50 || report.tasksCompletedThisWeek > 0) {
    highlight = `${report.tasksCompletedThisWeek} tarefa(s) concluída(s) e ${report.avgHabitRate}% de consistência nos hábitos essa semana.`;
  } else {
    highlight = 'Semana mais devagar. Escolha 1 tarefa e 1 hábito para focar agora.';
  }
  if (report.createdVsCompleted.created > report.createdVsCompleted.completed + 2) {
    highlight += ` Você criou ${report.createdVsCompleted.created} tarefas essa semana mas concluiu só ${report.createdVsCompleted.completed} — pode estar se sobrecarregando.`;
  }
  if (report.zombieTasks.length > 0) {
    highlight += ` ${report.zombieTasks.length} tarefa(s) parada(s) há tempo pedem uma decisão.`;
  }
  return highlight;
}

async function generateAIWeeklySummary(report) {
  if (!state.apiKey) return null;

  const topCorrelation = report.correlations[0];
  const worstWeekday = report.weekdayRates.filter(w => w.rate !== null).sort((a, b) => a.rate - b.rate)[0];

  const dataLines = [
    `Tarefas: ${report.tasksCompletedThisWeek}/${report.totalTasks} concluídas no total; ${report.createdVsCompleted.created} criadas e ${report.createdVsCompleted.completed} concluídas nos últimos 7 dias.`,
    `Hábitos: consistência média de ${report.avgHabitRate}% (7d), melhor streak ${report.bestStreak}d.`,
    report.avgMood !== null ? `Humor médio (7d): ${report.avgMood.toFixed(1)}/5.` : 'Sem registros de humor.',
    topCorrelation ? `Correlação: nos dias com "${topCorrelation.habit.name}" feito, tarefas concluídas por dia ${topCorrelation.avgDone >= topCorrelation.avgNotDone ? 'sobem' : 'caem'} de ${topCorrelation.avgNotDone.toFixed(1)} para ${topCorrelation.avgDone.toFixed(1)}.` : null,
    report.zombieTasks.length > 0 ? `${report.zombieTasks.length} tarefa(s) "zumbi" (reagendadas 3+ vezes ou paradas 14+ dias).` : null,
    worstWeekday ? `Pior dia da semana para hábitos: ${worstWeekday.label} (${worstWeekday.rate}%).` : null
  ].filter(Boolean).join('\n');

  try {
    const response = await callGroq({
      messages: [
        { role: 'system', content: 'Você é o Gênesis. Escreva um único parágrafo curto (2-3 frases), direto, em português, analisando os números abaixo. Sem parabenização vazia, sem repetir os números literalmente — sintetize o que eles significam.' },
        { role: 'user', content: dataLines }
      ]
    });
    return response.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('Erro ao gerar resumo semanal com IA:', err);
    return null;
  }
}

function renderZombieTaskItem(task) {
  const ageDays = Math.floor((Date.now() - getTaskCreatedAt(task)) / 86400000);
  const reasons = [];
  if ((task.rescheduleCount || 0) >= ZOMBIE_RESCHEDULE_THRESHOLD) reasons.push(`reagendada ${task.rescheduleCount}x`);
  if (ageDays >= ZOMBIE_AGE_DAYS_THRESHOLD) reasons.push(`parada há ${ageDays}d`);

  return `
    <div class="zombie-task-item" data-id="${task.id}">
      <div class="zombie-task-info">
        <span class="zombie-task-title">${escapeHtml(task.title)}</span>
        <span class="zombie-task-reason">${reasons.join(', ')}</span>
      </div>
      <div class="zombie-task-actions">
        <button type="button" class="btn-icon zombie-do-now" title="Fazer agora (prioridade alta)">⚡</button>
        <button type="button" class="btn-icon zombie-breakdown" title="Quebrar em subtarefas com IA">✂️</button>
        <button type="button" class="btn-danger-icon zombie-delete" title="Excluir">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>
  `;
}

function wireZombieTaskActions() {
  document.querySelectorAll('.zombie-do-now').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.closest('.zombie-task-item').getAttribute('data-id');
      await executeFunctionCall('editar_tarefa', { id, prioridade: 'high' });
      document.getElementById('report-modal').classList.add('hidden');
      document.querySelector('.tab-btn[data-tab="tab-tasks"]').click();
    });
  });

  document.querySelectorAll('.zombie-breakdown').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const item = e.currentTarget.closest('.zombie-task-item');
      const id = item.getAttribute('data-id');
      const task = state.tasks.find(t => t.id === id);
      document.getElementById('report-modal').classList.add('hidden');
      if (task) handleSendMessage(`Quebre a tarefa "${task.title}" em 2 ou 3 subtarefas menores e mais específicas.`);
    });
  });

  document.querySelectorAll('.zombie-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.closest('.zombie-task-item').getAttribute('data-id');
      if (!confirm('Excluir esta tarefa?')) return;
      await executeFunctionCall('deletar_tarefa', { id });
      renderWeeklyReport();
    });
  });
}

async function renderWeeklyReport() {
  const report = buildWeeklyReport();
  const body = document.getElementById('report-modal-body');

  const moodRow = report.avgMoodRounded !== null
    ? `<div class="report-stat-row">
        <span class="report-stat-label">${MOOD_EMOJIS[report.avgMoodRounded]} Humor médio da semana</span>
        <span class="report-stat-value">${MOOD_LABELS[report.avgMoodRounded]}</span>
      </div>`
    : `<div class="report-stat-row">
        <span class="report-stat-label">🙂 Humor da semana</span>
        <span class="report-stat-value" style="font-size:13px; color: var(--text-muted);">sem registros</span>
      </div>`;

  const createdVsCompletedRow = `
    <div class="report-stat-row">
      <span class="report-stat-label">📊 Criadas vs. concluídas (7d)</span>
      <span class="report-stat-value">${report.createdVsCompleted.created} / ${report.createdVsCompleted.completed}</span>
    </div>`;

  const correlationHtml = report.correlations.length > 0 ? `
    <div class="report-correlation">
      ${report.correlations.slice(0, 2).map(c => {
        const direction = c.avgDone >= c.avgNotDone ? 'mais' : 'menos';
        const diff = c.percentDiff !== null ? `${Math.abs(c.percentDiff)}%` : `${Math.abs(c.avgDone - c.avgNotDone).toFixed(1)} tarefas/dia`;
        return `<p>📈 Nos dias em que você marcou <strong>${escapeHtml(c.habit.name)}</strong>, concluiu <strong>${diff} ${direction}</strong> tarefas por dia (amostra: ${c.sampleDone} vs ${c.sampleNotDone} dias).</p>`;
      }).join('')}
    </div>` : '';

  const weekdayHtml = report.weekdayRates.length > 0 ? `
    <div class="report-weekday-rates">
      <div class="report-section-label">Consistência de hábitos por dia da semana (14d)</div>
      <div class="weekday-bars">
        ${report.weekdayRates.map(w => `
          <div class="weekday-bar-col">
            <div class="weekday-bar-track"><div class="weekday-bar-fill" style="height:${w.rate ?? 0}%"></div></div>
            <span class="weekday-bar-label">${w.label}</span>
            <span class="weekday-bar-value">${w.rate !== null ? w.rate + '%' : '-'}</span>
          </div>
        `).join('')}
      </div>
    </div>` : '';

  const zombieHtml = report.zombieTasks.length > 0 ? `
    <div class="report-zombie-section">
      <div class="report-section-label">⚠️ Isso importa mesmo? (${report.zombieTasks.length})</div>
      ${report.zombieTasks.map(renderZombieTaskItem).join('')}
    </div>` : '';

  body.innerHTML = `
    <div class="report-stat-row">
      <span class="report-stat-label">✅ Tarefas concluídas</span>
      <span class="report-stat-value">${report.tasksCompletedThisWeek}/${report.totalTasks}</span>
    </div>
    <div class="report-stat-row">
      <span class="report-stat-label">🔁 Consistência média de hábitos (7 dias)</span>
      <span class="report-stat-value">${report.avgHabitRate}%</span>
    </div>
    <div class="report-stat-row">
      <span class="report-stat-label">🔥 Melhor streak ativo</span>
      <span class="report-stat-value">${report.bestStreak} d</span>
    </div>
    <div class="report-stat-row">
      <span class="report-stat-label">📝 Notas atualizadas na semana</span>
      <span class="report-stat-value">${report.notesThisWeek}</span>
    </div>
    ${createdVsCompletedRow}
    ${moodRow}
    ${correlationHtml}
    ${weekdayHtml}
    ${zombieHtml}
    <div class="report-highlight" id="report-highlight-text">${buildFallbackHighlight(report)}</div>
  `;

  wireZombieTaskActions();

  if (state.apiKey) {
    const highlightEl = document.getElementById('report-highlight-text');
    highlightEl.textContent = 'Analisando seus números...';
    const aiSummary = await generateAIWeeklySummary(report);
    // Guard against the modal having been closed/reopened while awaiting
    const stillMounted = document.getElementById('report-highlight-text');
    if (stillMounted) stillMounted.innerHTML = aiSummary || buildFallbackHighlight(report);
  }
}

// ==========================================================================
// 7. HABIT & TASK REMINDERS (BROWSER NOTIFICATIONS)
// ==========================================================================

function updateNotificationButtonState() {
  const btn = document.getElementById('btn-notifications');
  btn.classList.toggle('active', state.notificationsEnabled);
  btn.title = state.notificationsEnabled ? 'Lembretes de hábitos ativados' : 'Ativar lembretes de hábitos';
}

// Shows a notification through the PWA's service worker when one is active
// (more reliable for an installed/backgrounded PWA than the bare Notification
// constructor), falling back to `new Notification()` for dev/unsupported
// environments. Either way, this stays 100% local — no server, no Web Push,
// no VAPID keys; it's just scheduling done client-side via setInterval.
async function showAppNotification(title, options) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready;
      if (registration) {
        await registration.showNotification(title, options);
        return;
      }
    } catch (err) {
      console.error('Erro ao notificar via service worker, usando fallback:', err);
    }
  }

  new Notification(title, options);
}

async function toggleNotifications() {
  if (!('Notification' in window)) {
    alert('Seu navegador não suporta notificações.');
    return;
  }

  if (state.notificationsEnabled) {
    state.notificationsEnabled = false;
    await localDb.setSetting('notificationsEnabled', false);
    updateNotificationButtonState();
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    alert('Permissão de notificação negada. Ative nas configurações do navegador para receber lembretes.');
    return;
  }

  state.notificationsEnabled = true;
  await localDb.setSetting('notificationsEnabled', true);
  updateNotificationButtonState();
  await showAppNotification('Gênesis', { body: 'Lembretes ativados! Vou avisar sobre hábitos com streak em risco e tarefas com prazo. ⏰' });
}

// Checks once per day (client-side) if there are pending habits and nudges the
// user — prioritizing genuine streak-at-risk cases (an active streak that
// today's inaction would break) over habits with no streak to lose yet.
async function checkHabitReminders() {
  if (!state.notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;

  const todayStr = getLocalDateString(0);
  const lastReminder = await localDb.getSetting('lastReminderDate', null);
  if (lastReminder === todayStr) return;

  const pendingHabits = state.habits.filter(h => !h.history[todayStr]);
  if (pendingHabits.length === 0) return;

  const atRiskHabits = pendingHabits.filter(h => calculateStreak(h.history) > 0);
  const habitsToMention = atRiskHabits.length > 0 ? atRiskHabits : pendingHabits;

  const names = habitsToMention.map(h => {
    const streak = calculateStreak(h.history);
    return streak > 0 ? `${h.name} (streak de ${streak}d em risco)` : h.name;
  }).join(', ');

  const title = atRiskHabits.length > 0 ? 'Gênesis - Streak em risco' : 'Gênesis - Lembrete de Hábitos';
  await showAppNotification(title, { body: `Você ainda não marcou hoje: ${names}` });
  await localDb.setSetting('lastReminderDate', todayStr);
}

// Checks once per day if there are tasks due today or overdue, and nudges the user
async function checkTaskDueReminders() {
  if (!state.notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;

  const todayStr = getLocalDateString(0);
  const lastReminder = await localDb.getSetting('lastTaskReminderDate', null);
  if (lastReminder === todayStr) return;

  const dueTasks = state.tasks.filter(t => !t.completed && t.due && t.due <= todayStr);
  if (dueTasks.length === 0) return;

  const overdueCount = dueTasks.filter(t => t.due < todayStr).length;
  const dueTodayCount = dueTasks.filter(t => t.due === todayStr).length;

  let body;
  if (dueTodayCount > 0 && overdueCount > 0) {
    body = `${dueTodayCount} tarefa(s) vencem hoje e ${overdueCount} está(ão) atrasada(s).`;
  } else if (dueTodayCount > 0) {
    body = `${dueTodayCount} tarefa(s) vencem hoje.`;
  } else {
    body = `${overdueCount} tarefa(s) está(ão) atrasada(s).`;
  }

  await showAppNotification('Gênesis - Tarefas', { body });
  await localDb.setSetting('lastTaskReminderDate', todayStr);
}

// ==========================================================================
// 8. VOICE COMMANDS (WEB SPEECH API)
// ==========================================================================

let speechRecognizer = null;
let isListening = false;

function getSpeechRecognitionClass() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function initVoiceInput() {
  const btn = document.getElementById('btn-voice-input');
  const SpeechRecognitionClass = getSpeechRecognitionClass();

  if (!SpeechRecognitionClass) {
    btn.disabled = true;
    btn.title = 'Comandos de voz não são suportados neste navegador';
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
    return;
  }

  speechRecognizer = new SpeechRecognitionClass();
  speechRecognizer.lang = 'pt-BR';
  speechRecognizer.interimResults = false;
  speechRecognizer.maxAlternatives = 1;

  speechRecognizer.addEventListener('result', (event) => {
    const transcript = event.results[0][0].transcript;
    const input = document.getElementById('chat-input');
    input.value = transcript;
    handleSendMessage(transcript);
    input.value = '';
  });

  speechRecognizer.addEventListener('end', () => {
    isListening = false;
    btn.classList.remove('recording');
  });

  speechRecognizer.addEventListener('error', (event) => {
    isListening = false;
    btn.classList.remove('recording');
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.error('Speech recognition error:', event.error);
    }
  });

  btn.addEventListener('click', () => {
    if (isListening) {
      speechRecognizer.stop();
      return;
    }
    isListening = true;
    btn.classList.add('recording');
    speechRecognizer.start();
  });
}

// ==========================================================================
// 10. BACKUP & RESTORE
// ==========================================================================

function buildBackupPayload() {
  return {
    genesisBackupVersion: 1,
    exportedAt: new Date().toISOString(),
    tasks: state.tasks,
    habits: state.habits,
    notes: state.notes,
    moods: state.moods,
    chatHistory: state.chatHistory
  };
}

// Exports the user's actual data (not credentials/tokens) as a downloadable JSON file
function exportData() {
  const blob = new Blob([JSON.stringify(buildBackupPayload(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `genesis-backup-${getLocalDateString(0)}.json`;
  a.click();
  URL.revokeObjectURL(url);

  // A manual export also counts as "you have a recent backup" for the auto-backup nudge
  localDb.setSetting('lastBackupAt', Date.now()).catch(() => {});
  hideBackupReminderBadge();
}

// ==========================================================================
// AUTOMATIC BACKUP (FILE SYSTEM ACCESS API, WITH MANUAL-EXPORT FALLBACK)
// ==========================================================================
// Chromium-based browsers can keep writing to the same user-picked file
// silently once permission is granted once. Safari/Firefox don't implement
// showSaveFilePicker at all — for those, and for anyone who never opts in,
// checkAutoBackup() just lights up a small badge on the backup icon instead
// of inventing a fragile workaround.
const AUTO_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function isFileSystemAccessSupported() {
  return 'showSaveFilePicker' in window;
}

function showBackupReminderBadge() {
  document.getElementById('btn-backup').classList.add('needs-backup');
}

function hideBackupReminderBadge() {
  document.getElementById('btn-backup').classList.remove('needs-backup');
}

async function writeAutoBackup(handle) {
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(buildBackupPayload(), null, 2));
  await writable.close();
  await localDb.setSetting('lastBackupAt', Date.now());
}

// Requires a user gesture (button click) — this is what showSaveFilePicker demands.
async function enableAutoBackup() {
  const statusEl = document.getElementById('auto-backup-status');

  if (!isFileSystemAccessSupported()) {
    statusEl.textContent = '⚠️ Seu navegador não suporta backup automático (comum no Safari/iOS). Use "Exportar Dados" manualmente de vez em quando.';
    return;
  }

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: `genesis-backup-${getLocalDateString(0)}.json`,
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
    });
    await localDb.setSetting('fsBackupHandle', handle);
    await writeAutoBackup(handle);
    hideBackupReminderBadge();
    statusEl.textContent = '✅ Backup automático ativado! Esse arquivo será atualizado sozinho a partir de agora.';
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Erro ao ativar backup automático:', err);
      statusEl.textContent = '❌ Não foi possível ativar o backup automático.';
    }
  }
}

// Runs periodically: if it's been 7+ days since the last backup (manual or
// automatic), try a silent write using the previously granted file handle.
// If that's not possible (no handle yet, permission revoked, or the API
// isn't supported at all), just surface the reminder badge — never re-prompt
// on its own, since showSaveFilePicker requires a real user gesture.
async function checkAutoBackup() {
  const lastBackupAt = await localDb.getSetting('lastBackupAt', 0);
  if (Date.now() - lastBackupAt <= AUTO_BACKUP_INTERVAL_MS) {
    hideBackupReminderBadge();
    return;
  }

  const handle = await localDb.getSetting('fsBackupHandle', null);
  if (handle) {
    try {
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      if (permission === 'granted') {
        await writeAutoBackup(handle);
        hideBackupReminderBadge();
        return;
      }
    } catch (err) {
      console.error('Erro ao verificar permissão do backup automático:', err);
    }
  }

  showBackupReminderBadge();
}

// Replaces all current data with the contents of a previously exported backup file
function importDataFromFile(file) {
  const reader = new FileReader();

  reader.onload = async (e) => {
    let data;
    try {
      data = JSON.parse(e.target.result);
    } catch {
      alert('Erro ao importar: o arquivo não é um JSON válido.');
      return;
    }

    if (!data || typeof data !== 'object') {
      alert('Erro ao importar: formato de backup não reconhecido.');
      return;
    }

    const confirmed = confirm('Importar vai substituir todos os dados atuais (tarefas, hábitos, notas, humor e conversa) deste navegador. Essa ação não pode ser desfeita. Continuar?');
    if (!confirmed) return;

    state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    state.habits = Array.isArray(data.habits) ? data.habits : [];
    state.notes = Array.isArray(data.notes) ? data.notes : [];
    state.moods = (data.moods && typeof data.moods === 'object') ? data.moods : {};
    state.chatHistory = Array.isArray(data.chatHistory) && data.chatHistory.length > 0 ? data.chatHistory : getInitialChat();
    state.activeNoteId = state.notes.length > 0 ? state.notes[0].id : null;

    await Promise.all([
      localDb.saveTasks(state.tasks),
      localDb.saveHabits(state.habits),
      localDb.saveNotes(state.notes),
      localDb.saveMoods(state.moods),
      localDb.saveChatHistory(state.chatHistory)
    ]);

    renderTasks();
    renderHabits();
    renderNotes();
    renderChat();
    renderMoodTracker();
    updateStats();

    alert('Backup importado com sucesso!');
  };

  reader.readAsText(file);
}

// ==========================================================================
// 12. SEARCH
// ==========================================================================

function renderSearchResults(query) {
  const resultsEl = document.getElementById('search-results');
  const q = query.trim().toLowerCase();

  if (!q) {
    resultsEl.innerHTML = '<p class="search-empty-hint">Digite para buscar em tarefas e notas.</p>';
    return;
  }

  const matchingTasks = state.tasks.filter(t => t.title.toLowerCase().includes(q));
  const noteMatches = searchNotesFuzzy(query);

  if (matchingTasks.length === 0 && noteMatches.length === 0) {
    resultsEl.innerHTML = '<p class="search-empty-hint">Nenhum resultado encontrado.</p>';
    return;
  }

  let html = '';
  if (matchingTasks.length > 0) {
    html += '<div class="search-group-label">Tarefas</div>';
    html += matchingTasks.map(t =>
      `<div class="search-result-item" data-type="task" data-id="${t.id}">${t.completed ? '✅' : '⬜'} ${escapeHtml(t.title)}</div>`
    ).join('');
  }
  if (noteMatches.length > 0) {
    html += '<div class="search-group-label">Notas</div>';
    html += noteMatches.map(({ note, matches }) => `
      <div class="search-result-item search-result-note" data-type="note" data-id="${note.id}">
        <div>📝 ${escapeHtml(note.title || 'Sem título')}</div>
        <div class="search-result-snippet">${buildHighlightedSnippet(note, matches)}</div>
      </div>
    `).join('');
  }
  resultsEl.innerHTML = html;

  resultsEl.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('click', () => {
      navigateToSearchResult(el.getAttribute('data-type'), el.getAttribute('data-id'));
    });
  });
}

// Closes the search modal and jumps to the matched task or note
function navigateToSearchResult(type, id) {
  document.getElementById('search-modal').classList.add('hidden');

  if (type === 'task') {
    document.querySelector('.tab-btn[data-tab="tab-tasks"]').click();
    state.taskFilter = 'all';
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.filter-btn[data-filter="all"]').classList.add('active');
    renderTasks();
    setTimeout(() => {
      const checkbox = document.querySelector(`.custom-checkbox[data-id="${id}"]`);
      const item = checkbox ? checkbox.closest('.task-item') : null;
      if (item) {
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        item.classList.add('search-highlight');
        setTimeout(() => item.classList.remove('search-highlight'), 1500);
      }
    }, 50);
  } else if (type === 'note') {
    document.querySelector('.tab-btn[data-tab="tab-notes"]').click();
    state.activeNoteId = id;
    renderNotes();
  }
}

// ==========================================================================
// 13. THEME
// ==========================================================================

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-icon-dark').classList.toggle('hidden', theme === 'light');
  document.getElementById('theme-icon-light').classList.toggle('hidden', theme !== 'light');
}

function initTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

  document.getElementById('btn-theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    localStorage.setItem(STATE_KEYS.THEME, next);
    applyTheme(next);
  });
}

// ==========================================================================
// 14. QUICK CAPTURE (NATURAL LANGUAGE)
// ==========================================================================

// Unaccented so \b word boundaries behave — JS's default (non-unicode) \b
// treats accented letters like "ã"/"ê" as non-word characters, so a pattern
// like /\bamanhã\b/ silently fails to match "amanhã," (boundary between two
// "non-word" characters never fires). Stripping diacritics before matching
// sidesteps the whole class of bugs instead of hand-tuning every regex.
const WEEKDAY_NAMES_PT = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

// Resolves common PT-BR relative date phrases client-side (cheap, instant,
// no API call needed for the trivial cases). Anything it doesn't recognize
// is left for the AI classifier to figure out from full-sentence context.
function parseRelativeDatePT(text) {
  const lower = stripDiacritics(text.toLowerCase());
  const today = new Date();
  const addDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };

  if (/\bhoje\b/.test(lower)) return { date: formatDateLocal(today), matchedText: 'hoje' };
  if (/\bdepois de amanha\b/.test(lower)) return { date: formatDateLocal(addDays(2)), matchedText: 'depois de amanhã' };
  if (/\bamanha\b/.test(lower)) return { date: formatDateLocal(addDays(1)), matchedText: 'amanhã' };

  const daquiDias = lower.match(/daqui\s+(\d+)\s+dias?/);
  if (daquiDias) return { date: formatDateLocal(addDays(Number(daquiDias[1]))), matchedText: daquiDias[0] };

  const daquiSemanas = lower.match(/daqui\s+(\d+)\s+semanas?/);
  if (daquiSemanas) return { date: formatDateLocal(addDays(Number(daquiSemanas[1]) * 7)), matchedText: daquiSemanas[0] };

  if (/\bfim d[eo] mes\b/.test(lower)) {
    const d = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return { date: formatDateLocal(d), matchedText: 'fim do mês' };
  }

  if (/\bfim de semana\b/.test(lower)) {
    const d = new Date(today);
    const diff = (6 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return { date: formatDateLocal(d), matchedText: 'fim de semana' };
  }

  for (let i = 0; i < WEEKDAY_NAMES_PT.length; i++) {
    const name = WEEKDAY_NAMES_PT[i];
    if (new RegExp(`\\b${name}(-feira)?\\b`).test(lower)) {
      const d = new Date(today);
      let diff = (i - d.getDay() + 7) % 7;
      if (diff === 0) diff = 7; // a named weekday means the next occurrence, not today
      d.setDate(d.getDate() + diff);
      return { date: formatDateLocal(d), matchedText: name };
    }
  }

  return null;
}

const QUICK_CAPTURE_TOOL = {
  type: 'function',
  function: {
    name: 'classificar_captura',
    description: 'Classifica uma captura rápida em texto livre como tarefa, hábito, nota ou humor, e extrai os campos estruturados.',
    parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['tarefa', 'habito', 'nota', 'humor'] },
        titulo: { type: 'string', description: 'Título/nome extraído (tarefa, hábito ou nota)' },
        prioridade: { type: 'string', enum: ['low', 'medium', 'high'] },
        prazo: { type: 'string', description: 'YYYY-MM-DD se detectado, vazio se não houver' },
        conteudo: { type: 'string', description: 'Corpo da nota, se tipo=nota' },
        valor_humor: { type: 'integer', minimum: 1, maximum: 5, description: 'Se tipo=humor, 1=péssimo a 5=ótimo' }
      },
      required: ['tipo']
    }
  }
};

async function classifyQuickCaptureWithAI(text) {
  const dateHint = parseRelativeDatePT(text);
  const systemMsg = {
    role: 'system',
    content: `Você classifica capturas rápidas de um app de produtividade pessoal. Hoje é ${getLocalDateString(0)}. Sempre chame a função classificar_captura.${
      dateHint ? ` Detecção local sugere a data ${dateHint.date} para o trecho "${dateHint.matchedText}" — use-a se fizer sentido, ajuste se achar melhor.` : ''
    }`
  };

  const response = await callGroq({
    messages: [systemMsg, { role: 'user', content: text }],
    tools: [QUICK_CAPTURE_TOOL],
    tool_choice: { type: 'function', function: { name: 'classificar_captura' } }
  });

  const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error('A IA não retornou uma classificação.');
  return JSON.parse(toolCall.function.arguments || '{}');
}

// No-API-key fallback: simple keyword/regex heuristics so quick capture
// still works (less accurately) in simulated mode.
function classifyQuickCaptureLocally(text) {
  const lower = stripDiacritics(text.toLowerCase());
  const dateHint = parseRelativeDatePT(text);

  if (/^(ideia|nota|anota(r)?)\s*[:\-]/i.test(text)) {
    const content = text.replace(/^(ideia|nota|anota(r)?)\s*[:\-]\s*/i, '');
    return { tipo: 'nota', titulo: content.slice(0, 60), conteudo: content };
  }

  const hasFeelingTrigger = /\bhumor\b|me sinto|sentindo|\bestou\b/.test(lower);
  const moodWordMatch = lower.match(/\b(otimo|incrivel|maravilhoso|animado|bem|bom|feliz|mal|ruim|triste|pessimo|horrivel)\b/);
  if (hasFeelingTrigger && moodWordMatch) {
    const word = moodWordMatch[1];
    let valor = 3;
    if (/otimo|incrivel|maravilhoso|animado/.test(word)) valor = 5;
    else if (/bem|bom|feliz/.test(word)) valor = 4;
    else if (/mal|ruim|triste/.test(word)) valor = 2;
    else if (/pessimo|horrivel/.test(word)) valor = 1;
    return { tipo: 'humor', valor_humor: valor };
  }

  if (/^(h[áa]bito)\s*[:\-]/i.test(text)) {
    return { tipo: 'habito', titulo: text.replace(/^(h[áa]bito)\s*[:\-]\s*/i, '') };
  }

  let prioridade = 'medium';
  if (/urgente|prioridade alta|importante/.test(lower)) prioridade = 'high';
  else if (/sem pressa|quando der|prioridade baixa/.test(lower)) prioridade = 'low';

  return { tipo: 'tarefa', titulo: text, prioridade, prazo: dateHint ? dateHint.date : '' };
}

const QUICK_CAPTURE_TYPE_LABELS = { tarefa: 'Tarefa', habito: 'Hábito', nota: 'Nota', humor: 'Humor' };

function closeQuickCapturePreview() {
  const previewEl = document.getElementById('quick-capture-preview');
  previewEl.classList.add('hidden');
  previewEl.innerHTML = '';
}

function renderQuickCapturePreview(parsed, originalText) {
  const previewEl = document.getElementById('quick-capture-preview');
  const tipo = ['tarefa', 'habito', 'nota', 'humor'].includes(parsed.tipo) ? parsed.tipo : 'tarefa';

  let fieldsHtml = '';
  if (tipo === 'tarefa') {
    fieldsHtml = `
      <div class="form-row"><input type="text" id="qc-titulo" value="${escapeHtml(parsed.titulo || originalText)}" /></div>
      <div class="form-row flex-row">
        <div class="form-col">
          <label>Prioridade</label>
          <select id="qc-prioridade">
            <option value="low" ${parsed.prioridade === 'low' ? 'selected' : ''}>Baixa</option>
            <option value="medium" ${(!parsed.prioridade || parsed.prioridade === 'medium') ? 'selected' : ''}>Média</option>
            <option value="high" ${parsed.prioridade === 'high' ? 'selected' : ''}>Alta</option>
          </select>
        </div>
        <div class="form-col">
          <label>Prazo</label>
          <input type="date" id="qc-prazo" value="${parsed.prazo || ''}" />
        </div>
      </div>`;
  } else if (tipo === 'habito') {
    fieldsHtml = `<div class="form-row"><input type="text" id="qc-nome" value="${escapeHtml(parsed.titulo || originalText)}" /></div>`;
  } else if (tipo === 'nota') {
    fieldsHtml = `
      <div class="form-row"><input type="text" id="qc-titulo" value="${escapeHtml(parsed.titulo || 'Nova nota')}" /></div>
      <div class="form-row"><textarea id="qc-conteudo" rows="3">${escapeHtml(parsed.conteudo || originalText)}</textarea></div>`;
  } else if (tipo === 'humor') {
    const value = parsed.valor_humor || 3;
    fieldsHtml = `<div class="mood-options" id="qc-mood-options">${
      [1, 2, 3, 4, 5].map(v => `<button type="button" class="mood-btn qc-mood-btn ${v === value ? 'active' : ''}" data-mood="${v}">${MOOD_EMOJIS[v]}</button>`).join('')
    }</div>`;
  }

  previewEl.classList.remove('hidden');
  previewEl.innerHTML = `
    <div class="quick-capture-type-label">Detectado como: <strong>${QUICK_CAPTURE_TYPE_LABELS[tipo]}</strong></div>
    ${fieldsHtml}
    <div class="form-actions">
      <button type="button" id="qc-cancel" class="btn btn-secondary">Cancelar</button>
      <button type="button" id="qc-save" class="btn btn-primary">Salvar</button>
    </div>
  `;

  if (tipo === 'humor') {
    previewEl.querySelectorAll('.qc-mood-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        previewEl.querySelectorAll('.qc-mood-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  document.getElementById('qc-cancel').addEventListener('click', closeQuickCapturePreview);
  document.getElementById('qc-save').addEventListener('click', () => saveQuickCapture(tipo));
}

async function saveQuickCapture(tipo) {
  if (tipo === 'tarefa') {
    const titulo = document.getElementById('qc-titulo').value.trim();
    if (!titulo) return;
    await executeFunctionCall('criar_tarefa', {
      titulo,
      prioridade: document.getElementById('qc-prioridade').value,
      prazo: document.getElementById('qc-prazo').value
    });
  } else if (tipo === 'habito') {
    const nome = document.getElementById('qc-nome').value.trim();
    if (!nome) return;
    await executeFunctionCall('criar_habito', { nome });
  } else if (tipo === 'nota') {
    const titulo = document.getElementById('qc-titulo').value.trim();
    if (!titulo) return;
    await executeFunctionCall('criar_nota', { titulo, conteudo: document.getElementById('qc-conteudo').value });
  } else if (tipo === 'humor') {
    const activeBtn = document.querySelector('.qc-mood-btn.active');
    await executeFunctionCall('registrar_humor', { valor: activeBtn ? Number(activeBtn.getAttribute('data-mood')) : 3 });
  }

  closeQuickCapturePreview();
  document.getElementById('quick-capture-input').value = '';
}

async function handleQuickCapture(text) {
  if (!text.trim()) return;

  const previewEl = document.getElementById('quick-capture-preview');
  previewEl.classList.remove('hidden');
  previewEl.innerHTML = '<p class="search-empty-hint">Analisando...</p>';

  let parsed;
  try {
    parsed = state.apiKey ? await classifyQuickCaptureWithAI(text) : classifyQuickCaptureLocally(text);
  } catch (err) {
    console.error('Erro ao classificar captura rápida:', err);
    parsed = classifyQuickCaptureLocally(text);
  }

  renderQuickCapturePreview(parsed, text);
}

function initQuickCapture() {
  const input = document.getElementById('quick-capture-input');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleQuickCapture(input.value);
    } else if (e.key === 'Escape') {
      closeQuickCapturePreview();
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  document.addEventListener('click', (e) => {
    const wrapper = document.querySelector('.quick-capture-wrapper');
    if (wrapper && !wrapper.contains(e.target)) closeQuickCapturePreview();
  });
}

// ==========================================================================
// 15. UI EVENT LISTENERS & INITIALIZATION
// ==========================================================================

function initEventListeners() {
  // Tabs switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tabId = e.currentTarget.getAttribute('data-tab');
      
      // Update buttons active class
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');

      // Update contents active class
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
      
      state.activeTab = tabId;
    });
  });

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

  // Search Modal
  const searchModal = document.getElementById('search-modal');
  const searchInput = document.getElementById('search-input');
  document.getElementById('btn-search').addEventListener('click', () => {
    searchModal.classList.remove('hidden');
    searchInput.value = '';
    renderSearchResults('');
    searchInput.focus();
  });
  document.getElementById('btn-close-search-modal').addEventListener('click', () => {
    searchModal.classList.add('hidden');
  });
  searchInput.addEventListener('input', (e) => renderSearchResults(e.target.value));

  // Backup & Restore Modal
  const backupModal = document.getElementById('backup-modal');
  document.getElementById('btn-backup').addEventListener('click', () => {
    backupModal.classList.remove('hidden');
  });
  document.getElementById('btn-close-backup-modal').addEventListener('click', () => {
    backupModal.classList.add('hidden');
  });
  document.getElementById('btn-export-data').addEventListener('click', exportData);
  document.getElementById('import-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importDataFromFile(file);
    e.target.value = '';
  });
  document.getElementById('btn-enable-auto-backup').addEventListener('click', enableAutoBackup);

  // Notifications Toggle
  document.getElementById('btn-notifications').addEventListener('click', () => {
    toggleNotifications();
  });

  // Mood Check-in
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const mood = Number(e.currentTarget.getAttribute('data-mood'));
      state.moods[getLocalDateString(0)] = mood;
      saveMoods();
    });
  });

  // Google Calendar Modal
  const calendarModal = document.getElementById('calendar-modal');
  const googleClientIdInput = document.getElementById('google-client-id-input');

  document.getElementById('btn-google-calendar').addEventListener('click', () => {
    googleClientIdInput.value = state.googleClientId;
    document.getElementById('calendar-status').style.display = 'none';
    calendarModal.classList.remove('hidden');
  });

  document.getElementById('btn-close-calendar-modal').addEventListener('click', () => {
    calendarModal.classList.add('hidden');
  });

  document.getElementById('btn-save-google-client-id').addEventListener('click', () => {
    state.googleClientId = googleClientIdInput.value.trim();
    localStorage.setItem(STATE_KEYS.GOOGLE_CLIENT_ID, state.googleClientId);
    initGoogleCalendarClient();
    showCalendarStatus('Client ID salvo. Clique em "Conectar e Sincronizar" para autorizar o acesso.', false);
  });

  document.getElementById('btn-connect-google-calendar').addEventListener('click', () => {
    if (!state.googleClientId) {
      showCalendarStatus('❌ Salve um Client ID válido primeiro.', true);
      return;
    }
    if (!googleTokenClient) initGoogleCalendarClient();
    if (!googleTokenClient) {
      showCalendarStatus('❌ Não foi possível iniciar o Google Identity Services. Recarregue a página e tente novamente.', true);
      return;
    }
    showCalendarStatus('Conectando...', false);
    syncTasksToGoogleCalendar();
  });

  // Weekly Report Modal
  const reportModal = document.getElementById('report-modal');
  document.getElementById('btn-weekly-report').addEventListener('click', () => {
    renderWeeklyReport();
    reportModal.classList.remove('hidden');
  });
  document.getElementById('btn-close-report-modal').addEventListener('click', () => {
    reportModal.classList.add('hidden');
  });

  // API Modal Toggles
  const apiModal = document.getElementById('api-modal');
  const apiKeyInput = document.getElementById('api-key-input');

  document.getElementById('btn-api-config').addEventListener('click', () => {
    apiKeyInput.value = state.apiKey;
    apiModal.classList.remove('hidden');
  });

  document.getElementById('btn-close-modal').addEventListener('click', () => {
    apiModal.classList.add('hidden');
  });

  document.getElementById('btn-save-api-key').addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    saveApiKey(key);
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
    apiModal.classList.add('hidden');
    
    state.chatHistory.push({
      sender: 'agent',
      text: '⚠️ **API Key removida.** Retornei ao modo de simulação local.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    saveChat();
  });

  // Task form, toggles and filters — wired by features/tasks.js
  initTasksUI();

  // Habit form and toggles — wired by features/habits.js
  initHabitsUI();

  // Notes actions
  document.getElementById('btn-new-note').addEventListener('click', () => {
    const newNote = {
      id: 'note_' + Date.now(),
      title: 'Nova Nota',
      body: '',
      updatedAt: Date.now()
    };
    state.notes.push(newNote);
    state.activeNoteId = newNote.id;
    saveNotes();
  });

  document.getElementById('btn-delete-note').addEventListener('click', () => {
    if (confirm('Tem certeza de que deseja excluir esta nota?')) {
      state.notes = state.notes.filter(n => n.id !== state.activeNoteId);
      state.activeNoteId = state.notes.length > 0 ? state.notes[0].id : null;
      saveNotes();
    }
  });

  // Notes inline saving on inputs
  const noteTitleInput = document.getElementById('note-title-input');
  const noteBodyInput = document.getElementById('note-body-input');

  let noteSaveDebounceTimer = null;

  const updateActiveNote = () => {
    const activeNote = state.notes.find(n => n.id === state.activeNoteId);
    if (activeNote) {
      activeNote.title = noteTitleInput.value;
      activeNote.body = noteBodyInput.value;
      activeNote.updatedAt = Date.now();

      // Debounced IndexedDB write so rapid typing doesn't fire a transaction
      // per keystroke; stats/cloud push follow the same cadence.
      clearTimeout(noteSaveDebounceTimer);
      noteSaveDebounceTimer = setTimeout(() => {
        localDb.saveNotes(state.notes).catch(err => console.error('Erro ao salvar notas:', err));
        updateStats();
        queueCloudPush();
      }, 400);

      // Only render note list sidebar to prevent input focus loss
      const container = document.getElementById('notes-list-container');
      const activeEl = container.querySelector('.note-item.active');
      if (activeEl) {
        activeEl.querySelector('.note-item-title').textContent = activeNote.title || 'Sem Título';
        const plainExcerpt = activeNote.body ? activeNote.body.replace(/[#*`>-]/g, '').substring(0, 40) : 'Sem conteúdo extra';
        activeEl.querySelector('.note-item-excerpt').textContent = plainExcerpt;
        const formattedDate = new Date(activeNote.updatedAt).toLocaleDateString('pt-BR', {day: 'numeric', month: 'short', hour: '2-digit', minute:'2-digit'});
        activeEl.querySelector('.note-item-date').textContent = formattedDate;
      }
    }
  };

  noteTitleInput.addEventListener('input', updateActiveNote);
  noteBodyInput.addEventListener('input', updateActiveNote);

  // Flush any pending debounced note write immediately if the user leaves
  // the page mid-typing, so the last few keystrokes aren't lost.
  window.addEventListener('beforeunload', () => {
    if (noteSaveDebounceTimer) {
      clearTimeout(noteSaveDebounceTimer);
      localDb.saveNotes(state.notes).catch(() => {});
    }
  });

  // Notes Markdown Preview Toggle
  const previewBtn = document.getElementById('btn-toggle-preview');
  const previewDiv = document.getElementById('note-body-preview');
  
  previewBtn.addEventListener('click', () => {
    const isPreviewing = !previewDiv.classList.contains('hidden');
    
    if (isPreviewing) {
      previewDiv.classList.add('hidden');
      noteBodyInput.classList.remove('hidden');
      previewBtn.textContent = 'Preview';
    } else {
      const activeNote = state.notes.find(n => n.id === state.activeNoteId);
      previewDiv.innerHTML = activeNote ? parseMarkdown(activeNote.body) : '';
      previewDiv.classList.remove('hidden');
      noteBodyInput.classList.add('hidden');
      previewBtn.textContent = 'Editar';
    }
  });
}

// ==========================================================================
// 16. APPLICATION BOOTSTRAP
// ==========================================================================

async function init() {
  await loadState();
  initClock();
  updateAgentStatus();
  updateNotificationButtonState();

  renderTasks();
  renderHabitsHeader();
  renderHabits();
  renderNotes();
  renderChat();
  renderMoodTracker();

  updateStats();
  initEventListeners();
  initVoiceInput();
  initGoogleCalendarClient();
  // Cloud sync re-renders everything after a remote update; the render hook
  // is injected here to keep cloudSync.js decoupled from the feature modules.
  initCloudSync(() => {
    renderTasks();
    renderHabits();
    renderNotes();
    renderMoodTracker();
    updateStats();
  });
  initTheme();
  initQuickCapture();

  checkHabitReminders();
  checkTaskDueReminders();
  checkAutoBackup();
  setInterval(() => {
    checkHabitReminders();
    checkTaskDueReminders();
    checkAutoBackup();
  }, 60 * 60 * 1000);
}

// Module scripts execute after HTML parsing, so DOMContentLoaded may already
// be pending or have fired by the time this runs — guard against double init.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
