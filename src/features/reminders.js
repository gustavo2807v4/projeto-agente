/* ==========================================================================
   GÊNESIS - HABIT & TASK REMINDERS (BROWSER NOTIFICATIONS)
   ========================================================================== */

import * as localDb from '../db.js';
import { state } from '../state.js';
import { calculateStreak, getLocalDateString } from '../utils.js';

export function updateNotificationButtonState() {
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
export async function checkHabitReminders() {
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
export async function checkTaskDueReminders() {
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

// Wires the notifications toggle button
export function initRemindersUI() {
  document.getElementById('btn-notifications').addEventListener('click', () => {
    toggleNotifications();
  });
}
