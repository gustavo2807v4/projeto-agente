/* ==========================================================================
   GÊNESIS - GOOGLE AGENDA SYNC (OAUTH VIA GOOGLE IDENTITY SERVICES)
   ========================================================================== */

import { state } from '../state.js';
// Circular with features/tasks.js (tasks importa delete/update de eventos
// daqui) — seguro em ESM porque todos os usos acontecem em tempo de execução,
// nunca durante a avaliação dos módulos.
import { saveTasks } from '../features/tasks.js';

export let googleTokenClient = null;
let googleTokenExpiresAt = 0;
let googleAuthResolvers = [];
let googleRefreshTimer = null;

export function initGoogleCalendarClient() {
  if (!state.googleClientId || !window.google?.accounts?.oauth2) return;

  googleTokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: state.googleClientId,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    callback: (response) => {
      const resolvers = googleAuthResolvers;
      googleAuthResolvers = [];

      if (response.error) {
        resolvers.forEach(r => r.reject(new Error(response.error)));
        return;
      }

      state.googleAccessToken = response.access_token;
      googleTokenExpiresAt = Date.now() + Number(response.expires_in || 3600) * 1000;
      scheduleGoogleTokenRefresh();
      resolvers.forEach(r => r.resolve(response.access_token));
    }
  });
}

// Refreshes the access token shortly before it expires, silently (no popup)
// whenever the browser still recognizes an active consent — this is what lets
// a sync keep working for hours without the user clicking "Conectar" again.
function scheduleGoogleTokenRefresh() {
  if (googleRefreshTimer) clearTimeout(googleRefreshTimer);
  const msUntilRefresh = Math.max(googleTokenExpiresAt - Date.now() - 60000, 5000);
  googleRefreshTimer = setTimeout(() => {
    requestGoogleAccessToken({ interactive: false }).catch(() => {
      // Silent refresh failed (consent expired/revoked) — the next sync attempt
      // will surface the "reconnect" message instead of failing quietly.
    });
  }, msUntilRefresh);
}

// Resolves a usable access token: reuses the current one if still valid,
// otherwise requests a new one — silently when possible, or via the
// interactive Google popup when a user gesture explicitly requested it.
export function requestGoogleAccessToken({ interactive } = {}) {
  if (!googleTokenClient) {
    return Promise.reject(new Error('Google Agenda não conectado. Salve um Client ID válido e clique em "Conectar e Sincronizar".'));
  }

  const stillValid = state.googleAccessToken && Date.now() < googleTokenExpiresAt - 60000;
  if (stillValid) return Promise.resolve(state.googleAccessToken);

  return new Promise((resolve, reject) => {
    googleAuthResolvers.push({ resolve, reject });
    googleTokenClient.requestAccessToken(interactive ? {} : { prompt: 'none' });
  });
}

export function showCalendarStatus(message, isError) {
  const statusEl = document.getElementById('calendar-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = message;
  statusEl.style.borderColor = isError ? 'var(--danger)' : 'var(--panel-border-hover)';
}

// Creates a Google Calendar all-day event for every pending task that has a due
// date and hasn't been synced yet (tracked via task.gcalEventId to avoid duplicates)
export async function syncTasksToGoogleCalendar() {
  try {
    await requestGoogleAccessToken({ interactive: true });
  } catch (err) {
    showCalendarStatus(`❌ ${err.message}`, true);
    return;
  }

  const tasksToSync = state.tasks.filter(t => t.due && !t.completed && !t.gcalEventId);

  if (tasksToSync.length === 0) {
    showCalendarStatus('✅ Conectado! Nenhuma tarefa pendente com prazo para sincronizar no momento.', false);
    return;
  }

  let synced = 0;
  let failed = 0;

  for (const task of tasksToSync) {
    try {
      const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${state.googleAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          summary: `📋 ${task.title}`,
          description: `Tarefa criada pelo Gênesis (prioridade: ${task.priority})`,
          start: { date: task.due },
          end: { date: task.due }
        })
      });

      if (!response.ok) throw new Error(await response.text());

      const event = await response.json();
      task.gcalEventId = event.id;
      synced++;
    } catch (err) {
      console.error('Erro ao sincronizar tarefa com Google Agenda:', err);
      failed++;
    }
  }

  saveTasks();
  showCalendarStatus(`✅ ${synced} tarefa(s) sincronizada(s) com o Google Agenda.${failed > 0 ? ` ⚠️ ${failed} falharam.` : ''}`, failed > 0 && synced === 0);
}

// Best-effort removal of a synced event — called when a task is completed or
// deleted, so the agenda doesn't accumulate stale entries. Silently no-ops if
// there's no active Google connection; a missing/already-deleted event (404/410)
// is not treated as a failure.
export async function deleteGoogleCalendarEvent(eventId) {
  try {
    await requestGoogleAccessToken({ interactive: false });
  } catch {
    return;
  }

  try {
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${state.googleAccessToken}` }
    });
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(await response.text());
    }
  } catch (err) {
    console.error('Erro ao remover evento do Google Agenda:', err);
  }
}

// Best-effort update of a synced event's date — called when a task with an
// existing Google Agenda event has its due date edited.
export async function updateGoogleCalendarEventDate(eventId, due) {
  try {
    await requestGoogleAccessToken({ interactive: false });
  } catch {
    return;
  }

  try {
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${state.googleAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ start: { date: due }, end: { date: due } })
    });
    if (!response.ok) throw new Error(await response.text());
  } catch (err) {
    console.error('Erro ao atualizar evento no Google Agenda:', err);
  }
}
