/* ==========================================================================
   GÊNESIS - STATE & STORAGE MANAGEMENT
   ========================================================================== */

import * as localDb from './db.js';
import { formatDateLocal, getLocalDateString } from './utils.js';

export const STATE_KEYS = {
  TASKS: 'genesis_tasks',
  HABITS: 'genesis_habits',
  NOTES: 'genesis_notes',
  CHAT: 'genesis_chat',
  API_KEY: 'genesis_api_key',
  NOTIFICATIONS: 'genesis_notifications_enabled',
  LAST_REMINDER: 'genesis_last_reminder_date',
  LAST_TASK_REMINDER: 'genesis_last_task_reminder_date',
  MOODS: 'genesis_moods',
  GOOGLE_CLIENT_ID: 'genesis_google_client_id',
  THEME: 'genesis_theme'
};

export let state = {
  tasks: [],
  habits: [],
  notes: [],
  chatHistory: [],
  apiKey: '',
  activeNoteId: null,
  activeTab: 'tab-tasks',
  taskFilter: 'all',
  notificationsEnabled: false,
  moods: {},
  googleClientId: '',
  googleAccessToken: '',
  editingTaskId: null
};

// Loads initial state from IndexedDB (migrating any legacy localStorage data
// first). Async — callers (init()) must await this before rendering.
export async function loadState() {
  await localDb.migrateFromLocalStorageIfNeeded();

  const [tasks, habits, notes, storedChat, moods] = await Promise.all([
    localDb.loadTasks(),
    localDb.loadHabits(),
    localDb.loadNotes(),
    localDb.loadChatHistory(),
    localDb.loadMoods()
  ]);

  // Seed mock/starter data exactly once, ever — never re-seed just because
  // the user genuinely emptied their lists later.
  const alreadySeeded = await localDb.getSetting('seededStarterData', false);
  const isEmptyFirstRun = !alreadySeeded && tasks.length === 0 && habits.length === 0 && notes.length === 0;

  if (isEmptyFirstRun) {
    state.tasks = getMockTasks();
    state.habits = getMockHabits();
    state.notes = getMockNotes();
    await Promise.all([
      localDb.saveTasks(state.tasks),
      localDb.saveHabits(state.habits),
      localDb.saveNotes(state.notes)
    ]);
  } else {
    state.tasks = tasks;
    state.habits = habits;
    state.notes = notes;
  }
  await localDb.setSetting('seededStarterData', true);

  state.chatHistory = (storedChat && storedChat.length > 0) ? storedChat : getInitialChat();
  state.moods = moods;

  // Small per-device scalars that stay in localStorage (see db.js comment
  // for why): Groq key, Google Client ID, and theme.
  state.apiKey = localStorage.getItem(STATE_KEYS.API_KEY) || '';
  state.googleClientId = localStorage.getItem(STATE_KEYS.GOOGLE_CLIENT_ID) || '';
  state.notificationsEnabled = await localDb.getSetting('notificationsEnabled', false);
}

export function saveApiKey(key) {
  state.apiKey = key;
  localStorage.setItem(STATE_KEYS.API_KEY, key);
  updateAgentStatus();
}

// ==========================================================================
// MOCK DATA INITIALIZERS
// ==========================================================================

export function getMockTasks() {
  const now = Date.now();
  return [
    { id: 't1', title: 'Criar estrutura do projeto Gênesis', priority: 'high', due: formatDateLocal(new Date()), completed: true, createdAt: now - 6 * 86400000, completedAt: now, rescheduleCount: 0 },
    { id: 't2', title: 'Implementar folha de estilo com Glassmorphism', priority: 'medium', due: formatDateLocal(new Date()), completed: false, createdAt: now - 3 * 86400000, rescheduleCount: 0 },
    { id: 't3', title: 'Configurar integração da API Key da IA', priority: 'high', due: '', completed: false, createdAt: now - 86400000, rescheduleCount: 0 }
  ];
}

export function getMockHabits() {
  const today = new Date();
  const format = (d) => formatDateLocal(d);

  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(today.getDate() - 2);

  return [
    {
      id: 'h1',
      name: 'Beber 2L de água',
      history: {
        [format(today)]: true,
        [format(yesterday)]: true,
        [format(twoDaysAgo)]: false
      }
    },
    {
      id: 'h2',
      name: 'Ler 10 páginas de livro',
      history: {
        [format(yesterday)]: true,
        [format(twoDaysAgo)]: true
      }
    }
  ];
}

export function getMockNotes() {
  return [
    {
      id: 'n1',
      title: '💡 Ideias para o Gênesis',
      body: '# Ideias para Evolução do Projeto\n\n- Adicionar comandos de voz.\n- Integrar com Google Agenda.\n- Criar relatórios de produtividade semanais baseados no humor.',
      updatedAt: Date.now() - 3600000
    },
    {
      id: 'n2',
      title: '📝 Metas de Julho',
      body: '# Metas Pessoais - Julho 2026\n\n1. Praticar esportes pelo menos 3x por semana.\n2. Concluir o curso de React/TypeScript.\n3. Beber água com mais regularidade.',
      updatedAt: Date.now() - 86400000
    }
  ];
}

export function getInitialChat() {
  return [
    {
      sender: 'agent',
      text: 'Olá! Eu sou o **Gênesis**, seu assistente de produtividade pessoal. 🚀\n\nPosso te ajudar a organizar suas tarefas, acompanhar seus hábitos e gerenciar suas notas. \n\n*Dica:* Clique em **"Configurar API"** no topo para me dar inteligência real com uma chave gratuita da Groq!',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ];
}

// ==========================================================================
// CROSS-CUTTING STATUS DISPLAYS
// ==========================================================================

// Update global stats counter cards
export function updateStats() {
  // Tasks Stats
  const totalTasks = state.tasks.length;
  const completedTasks = state.tasks.filter(t => t.completed).length;
  document.getElementById('stats-tasks-completed').textContent = `${completedTasks}/${totalTasks}`;

  // Habits Stats (today completion rate)
  const todayStr = getLocalDateString(0);
  const totalHabits = state.habits.length;
  if (totalHabits > 0) {
    const completedToday = state.habits.filter(h => h.history[todayStr]).length;
    const rate = Math.round((completedToday / totalHabits) * 100);
    document.getElementById('stats-habits-rate').textContent = `${rate}%`;
  } else {
    document.getElementById('stats-habits-rate').textContent = '0%';
  }

  // Notes Stats
  document.getElementById('stats-notes-count').textContent = state.notes.length;
}

// Update Agent connection label in Header / Chat Panel
export function updateAgentStatus() {
  const label = document.getElementById('agent-status-label');
  const pulse = document.querySelector('.avatar-pulse');
  if (state.apiKey) {
    label.textContent = 'Gênesis IA Ativo';
    label.style.color = '#a7f3d0';
    pulse.style.backgroundColor = 'var(--success)';
    pulse.style.boxShadow = '0 0 8px var(--success)';
  } else {
    label.textContent = 'Agente Simulado';
    label.style.color = 'var(--text-secondary)';
    pulse.style.backgroundColor = 'var(--warning)';
    pulse.style.boxShadow = '0 0 8px var(--warning)';
  }
}
