/* ==========================================================================
   GÊNESIS - VIEW DE MEMÓRIA (INSPEÇÃO E EDIÇÃO DO PERFIL)
   ==========================================================================
   Memória que o usuário não pode inspecionar nem corrigir vira problema —
   esta view existe para tornar o perfil auditável: ele edita a própria
   seção e apaga qualquer fato que o agente tenha anotado errado. */

import { escapeHtml } from '../utils.js';
import {
  getProfile,
  saveCoreProfile,
  deleteLearnedFact,
  MAX_CORE_CHARS,
  MAX_FACTS
} from '../agent/profile.js';

const CATEGORY_LABELS = {
  negocio: 'Negócio',
  preferencia: 'Preferência',
  padrao: 'Padrão',
  contexto: 'Contexto'
};

function renderFacts() {
  const container = document.getElementById('memory-facts-list');
  const label = document.getElementById('memory-facts-label');
  const facts = [...getProfile().learned].sort((a, b) => b.updatedAt - a.updatedAt);

  label.textContent = `Fatos aprendidos (${facts.length}/${MAX_FACTS})`;

  if (facts.length === 0) {
    container.innerHTML = '<p class="search-empty-hint">Nada aprendido ainda. Conforme você conversa, o Gênesis anota aqui o que for durável.</p>';
    return;
  }

  container.innerHTML = facts.map(fact => `
    <div class="memory-fact-item" data-id="${fact.id}">
      <div class="memory-fact-info">
        <span class="memory-fact-text">${escapeHtml(fact.text)}</span>
        <span class="memory-fact-meta">${CATEGORY_LABELS[fact.category] || fact.category} · ${new Date(fact.updatedAt).toLocaleDateString('pt-BR')}</span>
      </div>
      <button type="button" class="btn-danger-icon" title="Esquecer este fato">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
        </svg>
      </button>
    </div>
  `).join('');

  container.querySelectorAll('.memory-fact-item .btn-danger-icon').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.closest('.memory-fact-item').getAttribute('data-id');
      await deleteLearnedFact(id);
      renderFacts();
    });
  });
}

function updateCoreCounter() {
  const input = document.getElementById('memory-core-input');
  document.getElementById('memory-core-counter').textContent =
    `${input.value.length}/${MAX_CORE_CHARS} caracteres`;
}

// Recarrega a view a partir do perfil em memória (usado ao abrir o modal e
// quando a nuvem substitui o perfil local).
export function renderProfileView() {
  const modal = document.getElementById('memory-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  document.getElementById('memory-core-input').value = getProfile().core;
  updateCoreCounter();
  renderFacts();
}

export function initProfileUI() {
  const modal = document.getElementById('memory-modal');
  const coreInput = document.getElementById('memory-core-input');

  document.getElementById('btn-memory').addEventListener('click', () => {
    coreInput.value = getProfile().core;
    updateCoreCounter();
    renderFacts();
    modal.classList.remove('hidden');
  });

  document.getElementById('btn-close-memory-modal').addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  coreInput.addEventListener('input', updateCoreCounter);

  document.getElementById('btn-save-memory-core').addEventListener('click', async () => {
    await saveCoreProfile(coreInput.value);
    coreInput.value = getProfile().core;
    updateCoreCounter();
  });
}
