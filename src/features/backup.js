/* ==========================================================================
   GÊNESIS - BACKUP & RESTORE
   ========================================================================== */

import * as localDb from '../db.js';
import { state, getInitialChat, updateStats } from '../state.js';
import { getLocalDateString } from '../utils.js';
import { renderTasks } from './tasks.js';
import { renderHabits } from './habits.js';
import { renderNotes } from './notes.js';
import { renderMoodTracker } from './mood.js';
import { renderChat } from '../agent/chat.js';

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
export async function checkAutoBackup() {
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

// Wires the backup modal, export/import buttons and the auto-backup opt-in
export function initBackupUI() {
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
}
