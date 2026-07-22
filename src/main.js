/* ==========================================================================
   GÊNESIS - CORE JAVASCRIPT & STATE MANAGEMENT
   ========================================================================== */

import './style.css';
import * as localDb from './db.js';
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
import {
  saveNotes,
  renderNotes,
  searchNotesFuzzy,
  searchNotes,
  buildHighlightedSnippet,
  initNotesUI
} from './features/notes.js';
import {
  MOOD_EMOJIS,
  MOOD_LABELS,
  saveMoods,
  renderMoodTracker,
  getMoodTrendForLastDays,
  initMoodUI
} from './features/mood.js';
import { executeFunctionCall } from './agent/tools.js';
import { callGroq } from './agent/groq.js';
import { saveChat, renderChat, handleSendMessage } from './agent/chat.js';
import { initReportUI } from './features/report.js';
import { initQuickCapture } from './features/capture.js';
import {
  updateNotificationButtonState,
  checkHabitReminders,
  checkTaskDueReminders,
  initRemindersUI
} from './features/reminders.js';
import { initVoiceInput } from './features/voice.js';
import { checkAutoBackup, initBackupUI } from './features/backup.js';
import { initSearchUI } from './features/search.js';
import { initTheme } from './features/theme.js';
import { queueCloudPush, initCloudSync } from './integrations/cloudSync.js';

// Applied immediately at module load (before the rest of init) to avoid a
// flash of the wrong theme while the page loads.
document.documentElement.setAttribute('data-theme', localStorage.getItem(STATE_KEYS.THEME) || 'dark');

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

  // Global search modal — wired by features/search.js
  initSearchUI();

  // Backup modal, export/import and auto-backup — wired by features/backup.js
  initBackupUI();

  // Notifications toggle — wired by features/reminders.js
  initRemindersUI();

  // Mood check-in buttons — wired by features/mood.js
  initMoodUI();

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

  // Weekly report modal — wired by features/report.js
  initReportUI();

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

  // Notes editor, list and Markdown preview — wired by features/notes.js
  initNotesUI();
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
