/* ==========================================================================
   GÊNESIS - RECUPERAÇÃO SOBRE O HISTÓRICO
   ==========================================================================
   Busca sob demanda em notas + tarefas + humor, para responder "o que eu
   tinha decidido sobre X?". Só entra no contexto quando o modelo pede via a
   tool buscar_historico — o histórico NUNCA é despejado no system prompt.

   Reaproveita a busca fuzzy de notas que já existia (features/notes.js) e
   estende o mesmo critério para os outros dois tipos. */

import Fuse from 'fuse.js';
import { state } from '../state.js';
import { tokenizeWords } from '../utils.js';
import { searchNotesFuzzy } from '../features/notes.js';
import { MOOD_LABELS } from '../features/mood.js';

const MAX_RESULTS = 8;
const SNIPPET_CHARS = 220;

// Mesmo critério da busca de notas, para o ranking entre tipos ser comparável.
const FUSE_OPTIONS = {
  includeScore: true,
  threshold: 0.35,
  ignoreLocation: true,
  minMatchCharLength: 2
};

function searchTasks(query) {
  if (state.tasks.length === 0) return [];
  const fuse = new Fuse(state.tasks, { ...FUSE_OPTIONS, keys: ['title'] });
  return fuse.search(query).map(({ item, score }) => ({
    score: score ?? 1,
    tipo: 'tarefa',
    id: item.id,
    titulo: item.title,
    trecho: [
      item.completed ? 'concluída' : 'pendente',
      `prioridade ${item.priority}`,
      item.due ? `prazo ${item.due}` : null,
      item.recurrence ? `recorrência ${item.recurrence}` : null
    ].filter(Boolean).join(', '),
    data: item.completed && item.completedAt
      ? new Date(item.completedAt).toISOString().slice(0, 10)
      : (item.due || '')
  }));
}

// O humor é indexado como texto ("humor bom em 2026-07-14") para casar tanto
// com a palavra do humor quanto com a data.
function searchMoods(query) {
  const entries = Object.entries(state.moods || {});
  if (entries.length === 0) return [];

  const records = entries.map(([date, value]) => ({
    date,
    value,
    text: `humor ${MOOD_LABELS[value] || value} em ${date}`
  }));

  const fuse = new Fuse(records, { ...FUSE_OPTIONS, keys: ['text'] });
  return fuse.search(query).map(({ item, score }) => ({
    score: score ?? 1,
    tipo: 'humor',
    id: item.date,
    titulo: `Humor ${MOOD_LABELS[item.value] || item.value}`,
    trecho: `registrado em ${item.date}`,
    data: item.date
  }));
}

function searchNotesForHistory(query) {
  return searchNotesFuzzy(query).map(({ note, score }) => ({
    score: score ?? 1,
    tipo: 'nota',
    id: note.id,
    titulo: note.title || 'Sem título',
    trecho: (note.body || '').slice(0, SNIPPET_CHARS),
    data: note.updatedAt ? new Date(note.updatedAt).toISOString().slice(0, 10) : ''
  }));
}

// O modelo manda palavras-chave ("migrar site servidor"), e o Fuse casa a
// frase inteira como UM padrão — o que falha quando os termos aparecem
// separados no alvo. Por isso buscamos a frase completa E cada termo, e
// consolidamos pelo melhor score de cada item.
function buildSearchTerms(query) {
  return [query, ...tokenizeWords(query)];
}

// Busca nos três tipos e devolve os melhores resultados no geral (score menor
// = mais relevante, convenção do Fuse).
export function searchHistory(query) {
  const q = (query || '').trim();
  if (!q) return [];

  const best = new Map();

  for (const term of buildSearchTerms(q)) {
    const hits = [...searchNotesForHistory(term), ...searchTasks(term), ...searchMoods(term)];
    for (const hit of hits) {
      const key = `${hit.tipo}:${hit.id}`;
      const current = best.get(key);
      if (!current) {
        best.set(key, { ...hit, termHits: 1 });
      } else {
        current.termHits++;
        if (hit.score < current.score) current.score = hit.score;
      }
    }
  }

  return [...best.values()]
    // Casar mais termos da busca desempata a favor do item mais relevante.
    .sort((a, b) => (a.score / a.termHits) - (b.score / b.termHits))
    .slice(0, MAX_RESULTS)
    .map(({ score, termHits, ...result }) => result);
}

// Lógica da tool buscar_historico — mesmo formato de retorno das demais.
export function searchHistoryTool(query) {
  const results = searchHistory(query);
  if (results.length === 0) {
    return { status: 'ok', message: `Nada encontrado no histórico para "${query}".`, results: [] };
  }
  return {
    status: 'ok',
    message: `${results.length} resultado(s) no histórico.`,
    results
  };
}
