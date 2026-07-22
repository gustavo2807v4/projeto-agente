/* ==========================================================================
   GÊNESIS - CLOUD SYNC (FIREBASE AUTH + FIRESTORE)
   ========================================================================== */

import { auth, db, googleProvider } from '../firebase.js';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import * as localDb from '../db.js';
import { state } from '../state.js';

let cloudUnsubscribe = null;
let cloudPushTimer = null;
let isApplyingRemoteUpdate = false;

// Re-render hook wired by main.js at bootstrap (initCloudSync). Keeps this
// module free of imports from the feature modules — the only piece of the
// app that needs "re-render everything" after a remote update.
let onRemoteDataApplied = () => {};

function getUserDocRef(uid) {
  return doc(db, 'users', uid);
}

function updateSyncStatusText(text) {
  const el = document.getElementById('sync-status-text');
  if (!auth.currentUser) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden');
}

// Pushes the full local dataset to the user's cloud document, overwriting it.
async function pushLocalDataToCloud(uid) {
  try {
    await setDoc(getUserDocRef(uid), {
      tasks: state.tasks,
      habits: state.habits,
      notes: state.notes,
      moods: state.moods,
      updatedAt: serverTimestamp()
    });
    updateSyncStatusText(`Sincronizado às ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  } catch (err) {
    console.error('Erro ao sincronizar com a nuvem:', err);
    updateSyncStatusText('⚠️ Falha ao sincronizar');
  }
}

// Debounced push — called after every local save so rapid changes (e.g.
// typing in a note) don't trigger a network write per keystroke.
export function queueCloudPush() {
  if (!auth.currentUser || isApplyingRemoteUpdate) return;
  updateSyncStatusText('Sincronizando...');
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => pushLocalDataToCloud(auth.currentUser.uid), 800);
}

// Overwrites local state with data received from the cloud (another device,
// or the initial pull on sign-in) and persists + re-renders everything.
async function applyCloudDataToLocal(data) {
  isApplyingRemoteUpdate = true;

  state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
  state.habits = Array.isArray(data.habits) ? data.habits : [];
  state.notes = Array.isArray(data.notes) ? data.notes : [];
  state.moods = (data.moods && typeof data.moods === 'object') ? data.moods : {};
  state.activeNoteId = state.notes.length > 0 ? state.notes[0].id : null;

  await Promise.all([
    localDb.saveTasks(state.tasks),
    localDb.saveHabits(state.habits),
    localDb.saveNotes(state.notes),
    localDb.saveMoods(state.moods)
  ]);

  onRemoteDataApplied();

  isApplyingRemoteUpdate = false;
  updateSyncStatusText(`Atualizado às ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
}

// Starts listening for changes made from other signed-in devices
function startCloudSync(uid) {
  stopCloudSync();
  cloudUnsubscribe = onSnapshot(getUserDocRef(uid), (snapshot) => {
    if (snapshot.exists()) {
      applyCloudDataToLocal(snapshot.data());
    }
  });
}

function stopCloudSync() {
  if (cloudUnsubscribe) {
    cloudUnsubscribe();
    cloudUnsubscribe = null;
  }
}

function updateSyncUI(user) {
  const loginBtn = document.getElementById('btn-sync-login');
  const badge = document.getElementById('sync-user-badge');

  if (user) {
    loginBtn.classList.add('hidden');
    badge.classList.remove('hidden');
    document.getElementById('sync-user-avatar').src = user.photoURL || '';
    document.getElementById('sync-user-name').textContent = user.displayName || user.email || 'Conta';
  } else {
    loginBtn.classList.remove('hidden');
    badge.classList.add('hidden');
    document.getElementById('sync-status-text').classList.add('hidden');
  }
}

// Resolves the first-sign-in-on-this-device conflict: if the cloud already
// has data, ask whether to pull it down or overwrite it with what's local.
async function handleSignedIn(user) {
  const ref = getUserDocRef(user.uid);
  const snap = await getDoc(ref);

  if (snap.exists()) {
    const useCloud = confirm(
      'Encontramos dados sincronizados na nuvem para esta conta.\n\n' +
      'Clique OK para usar os dados da nuvem neste dispositivo (substitui os daqui).\n' +
      'Clique Cancelar para manter os dados deste dispositivo (substitui os da nuvem).'
    );
    if (useCloud) {
      applyCloudDataToLocal(snap.data());
    } else {
      await pushLocalDataToCloud(user.uid);
    }
  } else {
    // First time syncing this account — the cloud starts from this device's data
    await pushLocalDataToCloud(user.uid);
  }

  startCloudSync(user.uid);
}

export function initCloudSync(renderAll) {
  if (renderAll) onRemoteDataApplied = renderAll;

  onAuthStateChanged(auth, async (user) => {
    updateSyncUI(user);
    if (user) {
      await handleSignedIn(user);
    } else {
      stopCloudSync();
    }
  });

  document.getElementById('btn-sync-login').addEventListener('click', () => {
    signInWithPopup(auth, googleProvider).catch((err) => {
      console.error(err);
      alert('Não foi possível entrar com o Google. Tente novamente.');
    });
  });

  document.getElementById('btn-sync-logout').addEventListener('click', () => {
    if (confirm('Sair da conta? Seus dados continuam salvos neste dispositivo e na nuvem.')) {
      signOut(auth);
    }
  });
}
