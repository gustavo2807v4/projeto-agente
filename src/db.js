/* ==========================================================================
   GÊNESIS - INDEXEDDB PERSISTENCE LAYER
   ==========================================================================
   Replaces localStorage for bulk app data (tasks/habits/notes/moods/chat/
   settings) — async, no 5MB ceiling, not the first thing a browser evicts
   under storage pressure. The Groq API key and Google OAuth Client ID stay
   in localStorage on purpose (small, per-device credentials, not "data").
   Native IndexedDB is used directly — no external lib needed for this
   volume/shape of data. */

const DB_NAME = 'genesis-db';
const DB_VERSION = 1;

// habits store holds {id, name} only — daily completions live in habitLogs
// as individual rows, keyed by `${habitId}_${date}` and indexed by habitId.
// Callers never see this split: loadHabits()/saveHabits() reassemble the
// familiar `{ id, name, history: { 'YYYY-MM-DD': true } }` shape.
const STORE_CONFIG = {
  tasks: { keyPath: 'id' },
  habits: { keyPath: 'id' },
  habitLogs: { keyPath: 'id', index: 'habitId' },
  notes: { keyPath: 'id' },
  moods: { keyPath: 'id' }, // id = date string 'YYYY-MM-DD'
  settings: { keyPath: 'key' }
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const database = event.target.result;
      for (const [storeName, config] of Object.entries(STORE_CONFIG)) {
        if (database.objectStoreNames.contains(storeName)) continue;
        const store = database.createObjectStore(storeName, { keyPath: config.keyPath });
        if (config.index) store.createIndex(config.index, config.index, { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

async function getStore(storeName, mode) {
  const database = await openDb();
  return database.transaction(storeName, mode).objectStore(storeName);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- Generic store operations ----

export async function getAll(storeName) {
  const store = await getStore(storeName, 'readonly');
  return requestToPromise(store.getAll());
}

export async function get(storeName, key) {
  const store = await getStore(storeName, 'readonly');
  return requestToPromise(store.get(key));
}

export async function put(storeName, value) {
  const store = await getStore(storeName, 'readwrite');
  return requestToPromise(store.put(value));
}

export async function remove(storeName, key) {
  const store = await getStore(storeName, 'readwrite');
  return requestToPromise(store.delete(key));
}

export async function getByIndex(storeName, indexName, value) {
  const store = await getStore(storeName, 'readonly');
  return requestToPromise(store.index(indexName).getAll(value));
}

// Replaces the entire contents of a store in one transaction (mirrors the
// "overwrite whole collection" semantics the app already relies on, same as
// the old `localStorage.setItem(key, JSON.stringify(wholeArray))` pattern).
async function replaceAll(storeName, items) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.clear();
    for (const item of items) store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Settings (key/value) ----

export async function getSetting(key, defaultValue) {
  const row = await get('settings', key);
  return row ? row.value : defaultValue;
}

export async function setSetting(key, value) {
  await put('settings', { key, value });
}

// ---- Domain-specific helpers ----

export async function loadTasks() {
  return getAll('tasks');
}

export async function saveTasks(tasks) {
  await replaceAll('tasks', tasks);
}

export async function loadNotes() {
  return getAll('notes');
}

export async function saveNotes(notes) {
  await replaceAll('notes', notes);
}

// Moods are stored one row per day: { id: '2026-07-17', value: 4 }
export async function loadMoods() {
  const rows = await getAll('moods');
  const moods = {};
  for (const row of rows) moods[row.id] = row.value;
  return moods;
}

export async function saveMoods(moodsObject) {
  const rows = Object.entries(moodsObject).map(([date, value]) => ({ id: date, value }));
  await replaceAll('moods', rows);
}

// Reassembles `{ id, name, history }` habits from the split habits/habitLogs
// storage representation.
export async function loadHabits() {
  const [habitRows, logRows] = await Promise.all([getAll('habits'), getAll('habitLogs')]);
  return habitRows.map((habit) => {
    const history = {};
    for (const log of logRows) {
      if (log.habitId === habit.id) history[log.date] = log.completed;
    }
    return { ...habit, history };
  });
}

export async function saveHabits(habits) {
  const habitRows = habits.map(({ id, name }) => ({ id, name }));
  const logRows = [];
  for (const habit of habits) {
    for (const [date, completed] of Object.entries(habit.history || {})) {
      logRows.push({ id: `${habit.id}_${date}`, habitId: habit.id, date, completed });
    }
  }
  await Promise.all([replaceAll('habits', habitRows), replaceAll('habitLogs', logRows)]);
}

export async function loadChatHistory() {
  return getSetting('chatHistory', null);
}

export async function saveChatHistory(chatHistory) {
  await setSetting('chatHistory', chatHistory);
}

// ==========================================================================
// ONE-TIME MIGRATION FROM LOCALSTORAGE
// ==========================================================================
// Legacy localStorage keys this migration reads from and — only once the
// IndexedDB copy is verified — deletes. `genesis_api_key` and
// `genesis_google_client_id` are NEVER touched here; they stay in
// localStorage permanently by design. `genesis_theme` also stays in
// localStorage — it's read synchronously at module load (before any async
// IndexedDB call could resolve) specifically to avoid a flash of the wrong
// theme, so moving it here would reintroduce that flash for no benefit.
const LEGACY_KEYS = {
  TASKS: 'genesis_tasks',
  HABITS: 'genesis_habits',
  NOTES: 'genesis_notes',
  CHAT: 'genesis_chat',
  MOODS: 'genesis_moods',
  NOTIFICATIONS: 'genesis_notifications_enabled',
  LAST_REMINDER: 'genesis_last_reminder_date',
  LAST_TASK_REMINDER: 'genesis_last_task_reminder_date'
};

function readLegacyJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Detects legacy data, copies it into IndexedDB, re-reads it back to confirm
// the copy actually landed, and only then deletes the old localStorage keys.
// If verification fails for any piece, nothing is deleted and migration is
// retried on the next load — IndexedDB may end up with a partial copy from
// this attempt, but that's harmless since the next attempt just overwrites
// it (all writes here are full-collection replaces, not appends).
export async function migrateFromLocalStorageIfNeeded() {
  const alreadyMigrated = await getSetting('migratedFromLocalStorage', false);
  if (alreadyMigrated) return;

  const legacyTasks = readLegacyJSON(LEGACY_KEYS.TASKS);
  const legacyHabits = readLegacyJSON(LEGACY_KEYS.HABITS);
  const legacyNotes = readLegacyJSON(LEGACY_KEYS.NOTES);
  const legacyMoods = readLegacyJSON(LEGACY_KEYS.MOODS);
  const legacyChat = readLegacyJSON(LEGACY_KEYS.CHAT);
  const legacyNotifications = localStorage.getItem(LEGACY_KEYS.NOTIFICATIONS);
  const legacyLastReminder = localStorage.getItem(LEGACY_KEYS.LAST_REMINDER);
  const legacyLastTaskReminder = localStorage.getItem(LEGACY_KEYS.LAST_TASK_REMINDER);

  const hasLegacyData = legacyTasks || legacyHabits || legacyNotes || legacyMoods || legacyChat;

  if (!hasLegacyData) {
    // Fresh install, nothing to migrate — mark done so this check is skipped from now on.
    await setSetting('migratedFromLocalStorage', true);
    return;
  }

  if (legacyTasks) await saveTasks(legacyTasks);
  if (legacyHabits) await saveHabits(legacyHabits);
  if (legacyNotes) await saveNotes(legacyNotes);
  if (legacyMoods) await saveMoods(legacyMoods);
  if (legacyChat) await saveChatHistory(legacyChat);
  if (legacyNotifications) await setSetting('notificationsEnabled', legacyNotifications === 'true');
  if (legacyLastReminder) await setSetting('lastReminderDate', legacyLastReminder);
  if (legacyLastTaskReminder) await setSetting('lastTaskReminderDate', legacyLastTaskReminder);

  // Verify: re-read from IndexedDB and compare counts/keys against the source.
  const verifyTasks = legacyTasks ? await loadTasks() : [];
  const verifyHabits = legacyHabits ? await loadHabits() : [];
  const verifyNotes = legacyNotes ? await loadNotes() : [];
  const verifyMoods = legacyMoods ? await loadMoods() : {};
  const verifyChat = legacyChat ? await loadChatHistory() : [];

  const tasksOk = !legacyTasks || verifyTasks.length === legacyTasks.length;
  const habitsOk = !legacyHabits || verifyHabits.length === legacyHabits.length;
  const notesOk = !legacyNotes || verifyNotes.length === legacyNotes.length;
  const moodsOk = !legacyMoods || Object.keys(verifyMoods).length === Object.keys(legacyMoods).length;
  const chatOk = !legacyChat || (verifyChat && verifyChat.length === legacyChat.length);

  if (!(tasksOk && habitsOk && notesOk && moodsOk && chatOk)) {
    console.error('Genesis: falha ao validar migração para IndexedDB — dados do localStorage preservados, tentando de novo no próximo carregamento.');
    return;
  }

  // Validated — safe to remove the old copies now (API key / Google client
  // ID are not part of LEGACY_KEYS and are never removed here).
  for (const key of Object.values(LEGACY_KEYS)) {
    localStorage.removeItem(key);
  }

  await setSetting('migratedFromLocalStorage', true);
}
