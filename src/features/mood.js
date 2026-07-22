/* ==========================================================================
   GÊNESIS - MOOD TRACKER
   ========================================================================== */

import * as localDb from '../db.js';
import { state } from '../state.js';
import { getLocalDateString } from '../utils.js';
import { queueCloudPush } from '../integrations/cloudSync.js';

export const MOOD_EMOJIS = { 1: '😞', 2: '😕', 3: '😐', 4: '🙂', 5: '🤩' };
export const MOOD_LABELS = { 1: 'péssimo', 2: 'ruim', 3: 'neutro', 4: 'bom', 5: 'ótimo' };

export function saveMoods() {
  localDb.saveMoods(state.moods).catch(err => console.error('Erro ao salvar humor:', err));
  renderMoodTracker();
  queueCloudPush();
}

// Highlights today's selected mood button, if any
export function renderMoodTracker() {
  const todayStr = getLocalDateString(0);
  const selected = state.moods[todayStr];
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.getAttribute('data-mood')) === selected);
  });
}

export function getMoodTrendForLastDays(days) {
  const entries = [];
  for (let i = days - 1; i >= 0; i--) {
    const dateStr = getLocalDateString(i);
    if (state.moods[dateStr] !== undefined) entries.push(state.moods[dateStr]);
  }
  return entries;
}

// Wires the mood check-in buttons
export function initMoodUI() {
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const mood = Number(e.currentTarget.getAttribute('data-mood'));
      state.moods[getLocalDateString(0)] = mood;
      saveMoods();
    });
  });
}
