/* ==========================================================================
   GÊNESIS - CAMADA DE DADOS DO BRIEFING
   ==========================================================================
   Fina de propósito: só busca os dados e entrega para buildBriefing, que é
   pura. É AQUI que o Firebase é tocado — briefing.js não conhece Firebase,
   DOM nem rede.

   Dois caminhos, mesma função de briefing:
     buildBriefingFromState()  — usado pelo app (estado já carregado em
                                 memória, funciona offline, sem round-trip).
     fetchBriefingFromCloud()  — lê direto do Firestore. É o formato que um
                                 job externo (n8n num VPS, disparando sem o
                                 app aberto) vai usar: ele substitui ESTA
                                 função por uma leitura própria e reaproveita
                                 buildBriefing intacta. */

import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase.js';
import { state } from '../state.js';
import { buildBriefing } from './briefing.js';
import { getProfile, getProfileDocRef } from './profile.js';

// Caminho do doc de dados do usuário — mesmo que o cloudSync escreve.
function getUserDocRef(uid) {
  return doc(db, 'users', uid);
}

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

// Caminho do job externo: lê os dois docs e monta o briefing. Retorna null
// quando o usuário ainda não tem dados sincronizados na nuvem.
export async function fetchBriefingFromCloud(uid, now = new Date()) {
  const [dataSnap, profileSnap] = await Promise.all([
    getDoc(getUserDocRef(uid)),
    getDoc(getProfileDocRef(uid))
  ]);

  if (!dataSnap.exists()) return null;

  const data = dataSnap.data();
  return buildBriefing({
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    habits: Array.isArray(data.habits) ? data.habits : [],
    moods: (data.moods && typeof data.moods === 'object') ? data.moods : {},
    profile: profileSnap.exists() ? profileSnap.data() : null,
    now
  });
}
