/* ==========================================================================
   GÊNESIS - PERFIL DURÁVEL DO USUÁRIO
   ==========================================================================
   Fatos que não expiram sobre quem é o usuário, injetados no system prompt
   a cada mensagem. Duas seções distintas:
     core     — texto livre editado PELO USUÁRIO. O agente nunca escreve aqui.
     learned  — fatos que o agente persistiu via a tool lembrar_fato.

   Local-first, como o resto do app: sempre grava no IndexedDB e funciona sem
   login; autenticado, também escreve um doc separado no Firestore
   (users/{uid}/meta/profile) — não encosta no doc de dados existente. */

import * as localDb from '../db.js';
import { wordSimilarity } from '../utils.js';
import { auth, db } from '../firebase.js';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';

// --------------------------------------------------------------------------
// Tetos — o perfil vai no prompt a CADA mensagem, então tem que ser compacto.
// --------------------------------------------------------------------------
export const MAX_CORE_CHARS = 600;
export const MAX_FACTS = 50;
export const MAX_FACT_CHARS = 160;
// Teto do bloco montado (core + fatos) que entra no system prompt.
export const PROFILE_CONTEXT_BUDGET = 1500;

export const FACT_CATEGORIES = ['negocio', 'preferencia', 'padrao', 'contexto'];

// A partir desta similaridade de palavras dois fatos são considerados "o
// mesmo fato": o novo ATUALIZA o existente em vez de empilhar outra linha.
// Ex.: "Trabalha como dev freelancer" vs "...freelancer full-stack" (~0.86)
// consolida; "Projeto A com escopo X" vs "Projeto B com escopo Y" (~0.5) não.
const DEDUP_SIMILARITY_THRESHOLD = 0.6;

const SETTING_KEY = 'agentProfile';

function emptyProfile() {
  return { core: '', learned: [], updatedAt: 0 };
}

// Cache em memória — buildProfileContext() é síncrona (roda dentro da
// montagem do system prompt), então o perfil precisa já estar carregado.
let profile = emptyProfile();

export function getProfile() {
  return profile;
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    core: typeof source.core === 'string' ? source.core.slice(0, MAX_CORE_CHARS) : '',
    learned: Array.isArray(source.learned)
      ? source.learned
          .filter(f => f && typeof f.text === 'string' && f.text.trim())
          .slice(0, MAX_FACTS)
          .map(f => ({
            id: f.id || `fact_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            text: f.text.trim().slice(0, MAX_FACT_CHARS),
            category: FACT_CATEGORIES.includes(f.category) ? f.category : 'contexto',
            updatedAt: Number(f.updatedAt) || Date.now()
          }))
      : [],
    updatedAt: Number(source.updatedAt) || 0
  };
}

function getProfileDocRef(uid) {
  return doc(db, 'users', uid, 'meta', 'profile');
}

export async function loadProfile() {
  const stored = await localDb.getSetting(SETTING_KEY, null);
  profile = normalize(stored);
}

// Persiste local (sempre) e na nuvem (se autenticado). O push é
// fire-and-forget: a UI e o prompt já leem do cache em memória.
export async function saveProfile() {
  profile.updatedAt = Date.now();
  await localDb.setSetting(SETTING_KEY, profile);

  if (auth.currentUser) {
    setDoc(getProfileDocRef(auth.currentUser.uid), profile)
      .catch(err => console.error('Erro ao sincronizar perfil com a nuvem:', err));
  }
}

// Na entrada da conta, o doc da nuvem substitui o local se for mais recente
// (e sobe o local se a nuvem estiver vazia/desatualizada). Listener próprio
// para não acoplar ao cloudSync.js.
export function initProfileSync(onProfileReplaced) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    try {
      const snap = await getDoc(getProfileDocRef(user.uid));
      if (snap.exists()) {
        const remote = normalize(snap.data());
        if (remote.updatedAt > profile.updatedAt) {
          profile = remote;
          await localDb.setSetting(SETTING_KEY, profile);
          if (onProfileReplaced) onProfileReplaced();
          return;
        }
      }
      if (profile.updatedAt > 0) await setDoc(getProfileDocRef(user.uid), profile);
    } catch (err) {
      console.error('Erro ao sincronizar perfil:', err);
    }
  });
}

// ---- Seção core (usuário) ------------------------------------------------

export async function saveCoreProfile(text) {
  profile.core = (text || '').trim().slice(0, MAX_CORE_CHARS);
  await saveProfile();
}

// ---- Seção learned (agente) ----------------------------------------------

export async function deleteLearnedFact(id) {
  profile.learned = profile.learned.filter(f => f.id !== id);
  await saveProfile();
}

// Procura um fato existente que diga essencialmente a mesma coisa, pra
// atualizar em vez de empilhar — o modelo raramente repete a frase com as
// mesmas palavras exatas.
function findSimilarFact(text) {
  let best = null;
  let bestScore = 0;

  for (const fact of profile.learned) {
    const score = wordSimilarity(text, fact.text);
    if (score > bestScore) {
      bestScore = score;
      best = fact;
    }
  }

  return bestScore >= DEDUP_SIMILARITY_THRESHOLD ? best : null;
}

// Lógica da tool lembrar_fato. Retorna { status, message, undo? } no mesmo
// formato dos outros executores de tool.
export async function rememberFact(rawText, rawCategory) {
  const text = (rawText || '').trim().slice(0, MAX_FACT_CHARS);
  if (!text) {
    return { status: 'error', message: 'Fato vazio — nada a lembrar.' };
  }

  const category = FACT_CATEGORIES.includes(rawCategory) ? rawCategory : 'contexto';
  const existing = findSimilarFact(text);

  if (existing) {
    const previous = { text: existing.text, category: existing.category, updatedAt: existing.updatedAt };
    existing.text = text;
    existing.category = category;
    existing.updatedAt = Date.now();
    await saveProfile();
    return {
      status: 'ok',
      message: `Memória atualizada: "${text}".`,
      undo: async () => { Object.assign(existing, previous); await saveProfile(); }
    };
  }

  if (profile.learned.length >= MAX_FACTS) {
    return {
      status: 'error',
      message: `Memória cheia (${MAX_FACTS} fatos). Peça ao usuário para apagar algum fato antigo em "Memória" antes de guardar outro.`
    };
  }

  const fact = {
    id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    text,
    category,
    updatedAt: Date.now()
  };
  profile.learned.push(fact);
  await saveProfile();

  return {
    status: 'ok',
    message: `Memorizado: "${text}".`,
    undo: async () => {
      profile.learned = profile.learned.filter(f => f.id !== fact.id);
      await saveProfile();
    }
  };
}

// ---- Injeção no system prompt --------------------------------------------

// Bloco compacto pro system prompt. Síncrona (lê o cache) e sempre dentro do
// teto: o core é truncado e os fatos entram do mais recente pro mais antigo
// até o budget acabar. Sem perfil, devolve string vazia e o prompt fica
// idêntico ao que era antes desta camada existir.
const CORE_HEADER = 'PERFIL DO USUÁRIO (definido por ele; não invente nem contradiga):';
const FACTS_HEADER = 'FATOS APRENDIDOS (categoria|fato):';
const PART_SEPARATOR = '\n\n';

export function buildProfileContext() {
  const parts = [];

  const core = profile.core.trim().slice(0, MAX_CORE_CHARS);
  if (core) parts.push(`${CORE_HEADER}\n${core}`);

  // O que sobra do teto depois do core, já descontando os cabeçalhos e o
  // separador — contagem exata, para o bloco nunca estourar o budget.
  const usedByCore = parts.length > 0 ? parts[0].length + PART_SEPARATOR.length : 0;
  let remaining = PROFILE_CONTEXT_BUDGET - usedByCore - FACTS_HEADER.length - 1;

  const lines = [];
  for (const fact of [...profile.learned].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const line = `${fact.category}|${fact.text}`;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (cost > remaining) break;
    lines.push(line);
    remaining -= cost;
  }

  if (lines.length > 0) parts.push(`${FACTS_HEADER}\n${lines.join('\n')}`);

  return parts.join(PART_SEPARATOR);
}
