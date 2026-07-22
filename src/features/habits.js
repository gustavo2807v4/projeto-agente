/* ==========================================================================
   GÊNESIS - HABITS (TRACKING, RENDER & FORM HANDLERS)
   ========================================================================== */

import * as localDb from '../db.js';
import { state, updateStats } from '../state.js';
import { escapeHtml, calculateStreak, getLocalDateString } from '../utils.js';
import { queueCloudPush } from '../integrations/cloudSync.js';

export function saveHabits() {
  localDb.saveHabits(state.habits).catch(err => console.error('Erro ao salvar hábitos:', err));
  renderHabits();
  updateStats();
  queueCloudPush();
}

// Habit Days Header Generation
export function renderHabitsHeader() {
  const header = document.getElementById('habit-days-header');
  header.innerHTML = '';

  const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dayLabel = document.createElement('div');
    dayLabel.className = 'habit-day-label';
    dayLabel.innerHTML = `
      <span>${weekdays[d.getDay()]}</span>
      <span class="day-num">${d.getDate()}</span>
    `;
    header.appendChild(dayLabel);
  }
}

// Habit List Rendering
export function renderHabits() {
  const container = document.getElementById('habits-list-container');
  container.innerHTML = '';

  if (state.habits.length === 0) {
    container.innerHTML = '<div class="notes-empty-state"><p>Nenhum hábito cadastrado. Comece a monitorar!</p></div>';
    return;
  }

  state.habits.forEach(habit => {
    const streak = calculateStreak(habit.history);
    const item = document.createElement('div');
    item.className = 'habit-item';

    // Calculate total checked days in last 7 days for completion percentage
    let completedInLastWeek = 0;
    for (let i = 0; i < 7; i++) {
      const dateStr = getLocalDateString(i);
      if (habit.history[dateStr]) completedInLastWeek++;
    }
    const completionPercentage = Math.round((completedInLastWeek / 7) * 100);

    let daysHtml = '';
    // Generate checkmarks for the last 7 days (left to right: oldest to newest/today)
    for (let i = 6; i >= 0; i--) {
      const dateStr = getLocalDateString(i);
      const isCompleted = habit.history[dateStr] || false;
      daysHtml += `
        <button class="habit-day-btn ${isCompleted ? 'completed' : ''}"
                data-habit-id="${habit.id}"
                data-date="${dateStr}"
                title="${new Date(dateStr + 'T00:00:00').toLocaleDateString('pt-BR')}"></button>
      `;
    }

    item.innerHTML = `
      <div class="habit-info">
        <span class="habit-name">${escapeHtml(habit.name)}</span>
        <span class="habit-rate">Últimos 7 dias: ${completionPercentage}%</span>
      </div>
      <div class="habit-days">
        ${daysHtml}
      </div>
      <div class="habit-streak-display">
        <span>🔥</span>
        <span>${streak} d</span>
        <button class="btn-danger-icon btn-delete-habit" data-id="${habit.id}" title="Excluir hábito" style="margin-left: auto; padding: 4px; height: 26px; width: 26px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;

    // Click event for habit history toggle
    item.querySelectorAll('.habit-day-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const habitId = e.target.getAttribute('data-habit-id');
        const date = e.target.getAttribute('data-date');

        const targetHabit = state.habits.find(h => h.id === habitId);
        if (targetHabit) {
          targetHabit.history[date] = !targetHabit.history[date];
          saveHabits();
        }
      });
    });

    // Delete Habit event
    item.querySelector('.btn-delete-habit').addEventListener('click', (e) => {
      e.stopPropagation();
      state.habits = state.habits.filter(h => h.id !== habit.id);
      saveHabits();
    });

    container.appendChild(item);
  });
}

// Wires the habit form and its toggle buttons
export function initHabitsUI() {
  const habitForm = document.getElementById('habit-form');
  document.getElementById('btn-open-habit-form').addEventListener('click', () => {
    habitForm.classList.toggle('hidden');
    if (!habitForm.classList.contains('hidden')) {
      document.getElementById('habit-name').focus();
    }
  });

  document.getElementById('btn-cancel-habit').addEventListener('click', () => {
    habitForm.classList.add('hidden');
  });

  // Add Habit submit
  habitForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('habit-name').value.trim();

    if (!name) return;

    const newHabit = {
      id: 'habit_' + Date.now(),
      name,
      history: {}
    };

    state.habits.push(newHabit);
    saveHabits();

    habitForm.reset();
    habitForm.classList.add('hidden');
  });
}
