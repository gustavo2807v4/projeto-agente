/* ==========================================================================
   GÊNESIS - THEME TOGGLE
   ========================================================================== */

import { STATE_KEYS } from '../state.js';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-icon-dark').classList.toggle('hidden', theme === 'light');
  document.getElementById('theme-icon-light').classList.toggle('hidden', theme !== 'light');
}

export function initTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

  document.getElementById('btn-theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    localStorage.setItem(STATE_KEYS.THEME, next);
    applyTheme(next);
  });
}
