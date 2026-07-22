/* ==========================================================================
   GÊNESIS - BRIEFING PROATIVO
   ==========================================================================
   FUNÇÃO PURA: recebe os dados já carregados por argumento e devolve o
   briefing estruturado. Não toca DOM, não importa Firebase, não faz fetch, e
   não lê o relógio (o `now` é injetado) — por isso roda igual no navegador e
   num processo externo (ex.: um job n8n lendo o Firestore), que reaproveita
   esta função intacta e só troca a camada de dados. */

import { formatDateLocal, calculateStreak } from '../utils.js';

// --------------------------------------------------------------------------
// Limiares e cortes — ajuste aqui, não dentro das regras.
// --------------------------------------------------------------------------
export const MORNING_END_HOUR = 12;          // < 12h  -> "Bom dia"
export const AFTERNOON_END_HOUR = 18;        // < 18h  -> "Boa tarde"

// Só vale mencionar a ausência de humor a partir deste número de dias.
export const MOOD_GAP_DAYS = 3;
// Até onde procurar o último registro de humor antes de considerar "nunca".
export const MOOD_LOOKBACK_DAYS = 30;

// Streak menor que isso não vale como conquista a ser mencionada.
export const MIN_STREAK_TO_MENTION = 2;

// Mesma régua de "tarefa zumbi" que o relatório semanal já usa.
export const RESCHEDULE_SUGGESTION_THRESHOLD = 3;
// A partir de quantas atrasadas vale sugerir uma repriorização geral.
export const OVERDUE_TRIAGE_THRESHOLD = 3;

export const MAX_HIGHLIGHTS = 4;
export const MAX_SUGGESTIONS = 2;

// --------------------------------------------------------------------------

function shiftDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function plural(n, singular, pluralForm) {
  return n === 1 ? singular : pluralForm;
}

function greetingFor(now) {
  const hour = now.getHours();
  if (hour < MORNING_END_HOUR) return 'Bom dia';
  if (hour < AFTERNOON_END_HOUR) return 'Boa tarde';
  return 'Boa noite';
}

// Tarefas pendentes com prazo até hoje, separadas entre vencidas e de hoje.
function summarizeDueTasks(tasks, todayStr) {
  const pending = tasks.filter(t => !t.completed && t.due);
  return {
    overdue: pending.filter(t => t.due < todayStr),
    today: pending.filter(t => t.due === todayStr)
  };
}

function buildTasksHighlight({ overdue, today }) {
  const total = overdue.length + today.length;
  if (total === 0) return null;

  if (today.length > 0 && overdue.length > 0) {
    return {
      type: 'tasks_today',
      text: `Hoje você tem ${total} ${plural(total, 'tarefa', 'tarefas')} (${overdue.length} ${plural(overdue.length, 'atrasada', 'atrasadas')}).`
    };
  }
  if (today.length > 0) {
    return {
      type: 'tasks_today',
      text: `Hoje você tem ${today.length} ${plural(today.length, 'tarefa', 'tarefas')}.`
    };
  }
  return {
    type: 'tasks_overdue',
    text: `${overdue.length} ${plural(overdue.length, 'tarefa atrasada', 'tarefas atrasadas')}.`
  };
}

// "Ontem você concluiu 2 de 4" quando havia prazo ontem; senão, só a contagem.
function buildYesterdayHighlight(tasks, now) {
  const yesterdayStr = formatDateLocal(shiftDays(now, -1));

  const completedYesterday = tasks.filter(
    t => t.completed && t.completedAt && formatDateLocal(new Date(t.completedAt)) === yesterdayStr
  ).length;
  const dueYesterday = tasks.filter(t => t.due === yesterdayStr).length;

  if (dueYesterday > 0) {
    return { type: 'yesterday', text: `Ontem você concluiu ${completedYesterday} de ${dueYesterday}.` };
  }
  if (completedYesterday > 0) {
    return {
      type: 'yesterday',
      text: `Ontem você concluiu ${completedYesterday} ${plural(completedYesterday, 'tarefa', 'tarefas')}.`
    };
  }
  return null;
}

// Maior streak que morreu (não marcado nem ontem nem hoje, mas vivo até
// anteontem) — é o que vale a pena avisar.
function findBrokenStreak(habits, now) {
  const todayStr = formatDateLocal(now);
  const yesterdayStr = formatDateLocal(shiftDays(now, -1));
  const twoDaysAgo = shiftDays(now, -2);

  let best = null;
  for (const habit of habits) {
    const history = habit.history || {};
    if (history[todayStr] || history[yesterdayStr]) continue;

    const length = calculateStreak(history, twoDaysAgo);
    if (length >= MIN_STREAK_TO_MENTION && (!best || length > best.length)) {
      best = { habit, length };
    }
  }
  return best;
}

// Streak ainda vivo, mas que hoje ainda não foi marcado.
function findStreakAtRisk(habits, now) {
  const todayStr = formatDateLocal(now);

  let best = null;
  for (const habit of habits) {
    const history = habit.history || {};
    if (history[todayStr]) continue;

    const length = calculateStreak(history, now);
    if (length >= MIN_STREAK_TO_MENTION && (!best || length > best.length)) {
      best = { habit, length };
    }
  }
  return best;
}

// Dias desde o último registro de humor: 0 = hoje, null = nenhum registro
// dentro da janela de busca.
function daysSinceLastMood(moods, now) {
  for (let i = 0; i <= MOOD_LOOKBACK_DAYS; i++) {
    if (moods[formatDateLocal(shiftDays(now, -i))] !== undefined) return i;
  }
  return null;
}

function buildMoodHighlight(moods, now) {
  const hasAnyMood = Object.keys(moods || {}).length > 0;
  const gap = daysSinceLastMood(moods || {}, now);

  if (gap === null) {
    return hasAnyMood
      ? { type: 'mood_gap', text: 'Faz tempo que você não registra seu humor.' }
      : { type: 'mood_never', text: 'Você ainda não registrou seu humor.' };
  }
  if (gap >= MOOD_GAP_DAYS) {
    return { type: 'mood_gap', text: `Faz ${gap} dias sem registrar humor.` };
  }
  return null;
}

// Só entram sugestões com gatilho claro — nada de sugestão forçada.
function buildSuggestions({ tasks, overdue, brokenStreak, profile }) {
  const suggestions = [];

  const stuck = tasks
    .filter(t => !t.completed && (t.rescheduleCount || 0) >= RESCHEDULE_SUGGESTION_THRESHOLD)
    .sort((a, b) => (b.rescheduleCount || 0) - (a.rescheduleCount || 0))[0];

  if (stuck) {
    suggestions.push({
      type: 'zombie_task',
      taskId: stuck.id,
      text: `"${stuck.title}" já foi adiada ${stuck.rescheduleCount}x — quer quebrar em partes menores?`
    });
  }

  if (overdue.length >= OVERDUE_TRIAGE_THRESHOLD) {
    suggestions.push({
      type: 'overdue_triage',
      text: `São ${overdue.length} tarefas atrasadas — quer repriorizar antes de começar?`
    });
  }

  if (brokenStreak) {
    suggestions.push({
      type: 'habit_restart',
      habitId: brokenStreak.habit.id,
      text: `Quer retomar "${brokenStreak.habit.name}" hoje?`
    });
  }

  // Onboarding: nada pendente e perfil vazio — o agente rende muito mais
  // sabendo quem é o usuário.
  const profileIsEmpty = !profile || (!(profile.core || '').trim() && (profile.learned || []).length === 0);
  if (suggestions.length === 0 && profileIsEmpty) {
    suggestions.push({
      type: 'profile_setup',
      text: 'Quer me contar seus objetivos em "Memória"? Assim eu acerto mais nas sugestões.'
    });
  }

  return suggestions.slice(0, MAX_SUGGESTIONS);
}

/**
 * Monta o briefing a partir do estado do usuário.
 *
 * @param {object}   input
 * @param {Array}    input.tasks   tarefas ({id,title,due,completed,completedAt,rescheduleCount})
 * @param {Array}    input.habits  hábitos ({id,name,history})
 * @param {object}   input.moods   mapa 'YYYY-MM-DD' -> 1..5
 * @param {object}   input.profile perfil durável ({core, learned})
 * @param {Date}     input.now     instante de referência (injetado: mantém a função pura)
 * @returns {{greeting: string, highlights: Array, suggestions: Array, rawText: string}}
 */
export function buildBriefing({ tasks = [], habits = [], moods = {}, profile = null, now = new Date() } = {}) {
  const todayStr = formatDateLocal(now);
  const greeting = greetingFor(now);

  const dueTasks = summarizeDueTasks(tasks, todayStr);
  const brokenStreak = findBrokenStreak(habits, now);
  const atRiskStreak = brokenStreak ? null : findStreakAtRisk(habits, now);

  const highlights = [
    buildTasksHighlight(dueTasks),
    brokenStreak
      ? {
          type: 'habit_streak_broken',
          habitId: brokenStreak.habit.id,
          text: `Você quebrou um streak de ${brokenStreak.length} dias em "${brokenStreak.habit.name}".`
        }
      : atRiskStreak
        ? {
            type: 'habit_streak_at_risk',
            habitId: atRiskStreak.habit.id,
            text: `Streak de ${atRiskStreak.length} dias em "${atRiskStreak.habit.name}" ainda não marcado hoje.`
          }
        : null,
    buildMoodHighlight(moods, now),
    buildYesterdayHighlight(tasks, now)
  ].filter(Boolean).slice(0, MAX_HIGHLIGHTS);

  const suggestions = buildSuggestions({
    tasks,
    overdue: dueTasks.overdue,
    brokenStreak,
    profile
  });

  // Dia limpo: uma linha neutra em vez de inventar preocupação.
  if (highlights.length === 0) {
    highlights.push({ type: 'clear', text: 'Nada pendente por aqui.' });
  }

  const rawText = [`${greeting}.`, ...highlights.map(h => h.text), ...suggestions.map(s => s.text)].join(' ');

  return { greeting, highlights, suggestions, rawText };
}
