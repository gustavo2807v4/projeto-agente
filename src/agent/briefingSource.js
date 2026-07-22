/* ==========================================================================
   GÊNESIS - CAMADA DE DADOS DO BRIEFING
   ==========================================================================
   Fina de propósito: só reúne os dados e entrega para buildBriefing, que é
   pura (sem DOM, sem Firebase, sem rede). Um processo externo que queira
   gerar o mesmo briefing implementa a própria leitura e reaproveita
   buildBriefing intacta. */

import { state } from '../state.js';
import { buildBriefing } from './briefing.js';
import { getProfile } from './profile.js';

// Caminho do app: estado local já carregado pelo bootstrap.
export function buildBriefingFromState(now = new Date()) {
  return buildBriefing({
    tasks: state.tasks,
    habits: state.habits,
    moods: state.moods,
    profile: getProfile(),
    now
  });
}
