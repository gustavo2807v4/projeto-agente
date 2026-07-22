/* ==========================================================================
   GÊNESIS - GLOBAL SEARCH (TASKS + NOTES MODAL)
   ========================================================================== */

import { state } from '../state.js';
import { escapeHtml } from '../utils.js';
import { renderTasks } from './tasks.js';
import { renderNotes, searchNotesFuzzy, buildHighlightedSnippet } from './notes.js';

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

// Wires the global search modal
export function initSearchUI() {
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
}
