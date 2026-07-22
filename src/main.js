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
import { queueCloudPush, initCloudSync } from './integrations/cloudSync.js';

// Applied immediately at module load (before the rest of init) to avoid a
// flash of the wrong theme while the page loads.
document.documentElement.setAttribute('data-theme', localStorage.getItem(STATE_KEYS.THEME) || 'dark');

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
