/* ==========================================================================
   GÊNESIS - NOTES (EDITOR, RENDER & FUZZY SEARCH)
   ========================================================================== */

import Fuse from 'fuse.js';
import * as localDb from '../db.js';
import { state, updateStats } from '../state.js';
import { escapeHtml, parseMarkdown } from '../utils.js';
import { queueCloudPush } from '../integrations/cloudSync.js';

export function saveNotes() {
  localDb.saveNotes(state.notes).catch(err => console.error('Erro ao salvar notas:', err));
  renderNotes();
  updateStats();
  queueCloudPush();
}

// Notes Sidebar List Rendering
export function renderNotes() {
  const container = document.getElementById('notes-list-container');
  container.innerHTML = '';

  if (state.notes.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;">Sem notas salvas.</div>';
    showNotePane(null);
    return;
  }

  // Sort notes by updated date (most recent first)
  const sortedNotes = [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt);

  sortedNotes.forEach(note => {
    const item = document.createElement('div');
    item.className = `note-item ${state.activeNoteId === note.id ? 'active' : ''}`;

    const plainExcerpt = note.body ? note.body.replace(/[#*`>-]/g, '').substring(0, 40) : 'Sem conteúdo extra';
    const formattedDate = new Date(note.updatedAt).toLocaleDateString('pt-BR', {day: 'numeric', month: 'short', hour: '2-digit', minute:'2-digit'});

    item.innerHTML = `
      <span class="note-item-title">${escapeHtml(note.title || 'Sem Título')}</span>
      <span class="note-item-excerpt">${escapeHtml(plainExcerpt)}</span>
      <span class="note-item-date">${formattedDate}</span>
    `;

    item.addEventListener('click', () => {
      state.activeNoteId = note.id;
      renderNotes();
      showNotePane(note);
    });

    container.appendChild(item);
  });

  // Keep editor active if activeNoteId exists
  const activeNote = state.notes.find(n => n.id === state.activeNoteId);
  if (activeNote) {
    showNotePane(activeNote);
  } else {
    // If activeNote doesn't exist but notes exist, select first note
    state.activeNoteId = sortedNotes[0].id;
    showNotePane(sortedNotes[0]);
    renderNotes();
  }
}

// Toggle Note Editor pane or Empty state pane
export function showNotePane(note) {
  const editorPane = document.getElementById('note-editor-pane');
  const emptyPane = document.getElementById('note-empty-pane');

  if (!note) {
    editorPane.classList.add('hidden');
    emptyPane.classList.remove('hidden');
    return;
  }

  editorPane.classList.remove('hidden');
  emptyPane.classList.add('hidden');

  // Fill in inputs if not currently focused to prevent losing cursor position
  const titleInput = document.getElementById('note-title-input');
  const bodyInput = document.getElementById('note-body-input');

  if (document.activeElement !== titleInput) titleInput.value = note.title;
  if (document.activeElement !== bodyInput) bodyInput.value = note.body;

  // Render preview if open
  const previewContainer = document.getElementById('note-body-preview');
  if (!previewContainer.classList.contains('hidden')) {
    previewContainer.innerHTML = parseMarkdown(note.body);
  }
}

// Fuzzy search over note title + body (typo-tolerant, no exact substring
// needed). Rebuilt fresh per search — at personal-note volumes this is
// cheap enough that caching the index isn't worth the invalidation logic.
export function searchNotesFuzzy(query) {
  const q = (query || '').trim();
  if (!q) return [];

  const fuse = new Fuse(state.notes, {
    keys: ['title', 'body'],
    includeMatches: true,
    // `score` é usado por agent/retrieval.js pra ranquear notas junto com
    // tarefas e humor; a UI de busca ignora o campo.
    includeScore: true,
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 2
  });

  return fuse.search(q).map(result => ({
    note: result.item,
    matches: result.matches || [],
    score: result.score ?? 1
  }));
}

// Used by the buscar_notas tool — just needs the notes, ranked by relevance
export function searchNotes(query) {
  return searchNotesFuzzy(query).map(r => r.note);
}

// Builds a highlighted snippet around the first body match (or a plain lead-in
// if only the title matched), for the search results UI.
export function buildHighlightedSnippet(note, matches, maxLen = 140) {
  const body = note.body || '';
  const bodyMatch = matches.find(m => m.key === 'body' && m.indices && m.indices.length > 0);

  if (!bodyMatch) {
    return escapeHtml(body.slice(0, maxLen)) + (body.length > maxLen ? '…' : '');
  }

  const [start, end] = bodyMatch.indices[0];
  const windowStart = Math.max(0, start - 40);
  const windowEnd = Math.min(body.length, end + 1 + 60);

  const before = escapeHtml(body.slice(windowStart, start));
  const matched = escapeHtml(body.slice(start, end + 1));
  const after = escapeHtml(body.slice(end + 1, windowEnd));

  return `${windowStart > 0 ? '…' : ''}${before}<mark>${matched}</mark>${after}${windowEnd < body.length ? '…' : ''}`;
}

// Wires note creation/deletion, inline editing (debounced) and the Markdown preview
export function initNotesUI() {
  document.getElementById('btn-new-note').addEventListener('click', () => {
    const newNote = {
      id: 'note_' + Date.now(),
      title: 'Nova Nota',
      body: '',
      updatedAt: Date.now()
    };
    state.notes.push(newNote);
    state.activeNoteId = newNote.id;
    saveNotes();
  });

  document.getElementById('btn-delete-note').addEventListener('click', () => {
    if (confirm('Tem certeza de que deseja excluir esta nota?')) {
      state.notes = state.notes.filter(n => n.id !== state.activeNoteId);
      state.activeNoteId = state.notes.length > 0 ? state.notes[0].id : null;
      saveNotes();
    }
  });

  // Notes inline saving on inputs
  const noteTitleInput = document.getElementById('note-title-input');
  const noteBodyInput = document.getElementById('note-body-input');

  let noteSaveDebounceTimer = null;

  const updateActiveNote = () => {
    const activeNote = state.notes.find(n => n.id === state.activeNoteId);
    if (activeNote) {
      activeNote.title = noteTitleInput.value;
      activeNote.body = noteBodyInput.value;
      activeNote.updatedAt = Date.now();

      // Debounced IndexedDB write so rapid typing doesn't fire a transaction
      // per keystroke; stats/cloud push follow the same cadence.
      clearTimeout(noteSaveDebounceTimer);
      noteSaveDebounceTimer = setTimeout(() => {
        localDb.saveNotes(state.notes).catch(err => console.error('Erro ao salvar notas:', err));
        updateStats();
        queueCloudPush();
      }, 400);

      // Only render note list sidebar to prevent input focus loss
      const container = document.getElementById('notes-list-container');
      const activeEl = container.querySelector('.note-item.active');
      if (activeEl) {
        activeEl.querySelector('.note-item-title').textContent = activeNote.title || 'Sem Título';
        const plainExcerpt = activeNote.body ? activeNote.body.replace(/[#*`>-]/g, '').substring(0, 40) : 'Sem conteúdo extra';
        activeEl.querySelector('.note-item-excerpt').textContent = plainExcerpt;
        const formattedDate = new Date(activeNote.updatedAt).toLocaleDateString('pt-BR', {day: 'numeric', month: 'short', hour: '2-digit', minute:'2-digit'});
        activeEl.querySelector('.note-item-date').textContent = formattedDate;
      }
    }
  };

  noteTitleInput.addEventListener('input', updateActiveNote);
  noteBodyInput.addEventListener('input', updateActiveNote);

  // Flush any pending debounced note write immediately if the user leaves
  // the page mid-typing, so the last few keystrokes aren't lost.
  window.addEventListener('beforeunload', () => {
    if (noteSaveDebounceTimer) {
      clearTimeout(noteSaveDebounceTimer);
      localDb.saveNotes(state.notes).catch(() => {});
    }
  });

  // Notes Markdown Preview Toggle
  const previewBtn = document.getElementById('btn-toggle-preview');
  const previewDiv = document.getElementById('note-body-preview');

  previewBtn.addEventListener('click', () => {
    const isPreviewing = !previewDiv.classList.contains('hidden');

    if (isPreviewing) {
      previewDiv.classList.add('hidden');
      noteBodyInput.classList.remove('hidden');
      previewBtn.textContent = 'Preview';
    } else {
      const activeNote = state.notes.find(n => n.id === state.activeNoteId);
      previewDiv.innerHTML = activeNote ? parseMarkdown(activeNote.body) : '';
      previewDiv.classList.remove('hidden');
      noteBodyInput.classList.add('hidden');
      previewBtn.textContent = 'Editar';
    }
  });
}
