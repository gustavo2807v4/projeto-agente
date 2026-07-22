/* ==========================================================================
   GÊNESIS - ENTRY POINT (BOOTSTRAP)
   Importa e conecta os módulos; a lógica vive em src/agent, src/features
   e src/integrations.
   ========================================================================== */

import './style.css';
import { STATE_KEYS, state, loadState, updateStats, updateAgentStatus } from './state.js';
import { initClock } from './utils.js';
import { renderTasks, initTasksUI } from './features/tasks.js';
import { renderHabits, renderHabitsHeader, initHabitsUI } from './features/habits.js';
import { renderNotes, initNotesUI } from './features/notes.js';
import { renderMoodTracker, initMoodUI } from './features/mood.js';
import { renderChat, initChatUI } from './agent/chat.js';
import { loadProfile, initProfileSync } from './agent/profile.js';
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
import { initGoogleCalendarClient, initGoogleCalendarUI } from './integrations/googleCalendar.js';
import { initCloudSync } from './integrations/cloudSync.js';

// Applied immediately at module load (before the rest of init) to avoid a
// flash of the wrong theme while the page loads.
document.documentElement.setAttribute('data-theme', localStorage.getItem(STATE_KEYS.THEME) || 'dark');

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

  // Chat form, suggested prompts and API key modal — wired by agent/chat.js
  initChatUI();

  // Global search modal — wired by features/search.js
  initSearchUI();

  // Backup modal, export/import and auto-backup — wired by features/backup.js
  initBackupUI();

  // Notifications toggle — wired by features/reminders.js
  initRemindersUI();

  // Mood check-in buttons — wired by features/mood.js
  initMoodUI();

  // Google Calendar modal — wired by integrations/googleCalendar.js
  initGoogleCalendarUI();

  // Weekly report modal — wired by features/report.js
  initReportUI();

  // Task form, toggles and filters — wired by features/tasks.js
  initTasksUI();

  // Habit form and toggles — wired by features/habits.js
  initHabitsUI();

  // Notes editor, list and Markdown preview — wired by features/notes.js
  initNotesUI();
}

async function init() {
  await loadState();
  // Perfil durável do agente: precisa estar em memória antes do primeiro
  // system prompt, que o lê de forma síncrona.
  await loadProfile();
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
  // Perfil tem doc próprio no Firestore e listener próprio de auth.
  initProfileSync();
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
