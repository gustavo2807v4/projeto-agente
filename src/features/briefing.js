/* ==========================================================================
   GÊNESIS - CARD DE BRIEFING (UI)
   ==========================================================================
   Exibe o briefing do dia uma única vez, de forma discreta e dispensável.
   Toda a decisão do QUE dizer está em agent/briefing.js (pura); aqui só
   decidimos QUANDO mostrar e como renderizar. */

import * as localDb from '../db.js';
import { escapeHtml, formatDateLocal } from '../utils.js';
import { buildBriefingFromState } from '../agent/briefingSource.js';

const LAST_SHOWN_SETTING = 'lastBriefingDate';

function renderBriefing(briefing) {
  const card = document.getElementById('briefing-card');

  const highlights = briefing.highlights
    .map(h => `<li class="briefing-highlight">${escapeHtml(h.text)}</li>`)
    .join('');

  const suggestions = briefing.suggestions.length > 0
    ? `<ul class="briefing-suggestions">${briefing.suggestions
        .map(s => `<li class="briefing-suggestion">${escapeHtml(s.text)}</li>`)
        .join('')}</ul>`
    : '';

  card.innerHTML = `
    <div class="briefing-header">
      <span class="briefing-greeting">${escapeHtml(briefing.greeting)}</span>
      <button type="button" id="btn-dismiss-briefing" class="btn-icon" title="Dispensar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <ul class="briefing-highlights">${highlights}</ul>
    ${suggestions}
  `;

  card.classList.remove('hidden');
  document.getElementById('btn-dismiss-briefing').addEventListener('click', () => {
    card.classList.add('hidden');
  });
}

// Mostra o briefing no máximo uma vez por dia. A data é gravada assim que ele
// aparece (não no dispensar), então recarregar a página também não repete.
export async function initBriefing(now = new Date()) {
  const todayStr = formatDateLocal(now);

  const lastShown = await localDb.getSetting(LAST_SHOWN_SETTING, null);
  if (lastShown === todayStr) return;

  renderBriefing(buildBriefingFromState(now));
  await localDb.setSetting(LAST_SHOWN_SETTING, todayStr);
}
