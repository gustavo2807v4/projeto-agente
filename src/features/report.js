/* ==========================================================================
   GÊNESIS - WEEKLY REPORT
   ========================================================================== */

import { state } from '../state.js';
import { escapeHtml, formatDateLocal, getLocalDateString, calculateStreak } from '../utils.js';
import { MOOD_EMOJIS, MOOD_LABELS, getMoodTrendForLastDays } from './mood.js';
import { getTaskCreatedAt } from './tasks.js';
import { chatCompletion as callGroq } from '../agent/providers/groq.js';
import { executeFunctionCall } from '../agent/tools.js';
import { handleSendMessage } from '../agent/chat.js';

const WEEKDAY_LABELS_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MIN_CORRELATION_SAMPLE_DAYS = 5;
const ZOMBIE_RESCHEDULE_THRESHOLD = 3;
const ZOMBIE_AGE_DAYS_THRESHOLD = 14;

function getTasksCompletedOnDate(dateStr) {
  return state.tasks.filter(t => t.completed && t.completedAt && formatDateLocal(new Date(t.completedAt)) === dateStr).length;
}

// For each habit, compares avg. tasks completed on days it was done vs. days
// it wasn't, over the last month. Only speaks up when both groups have a
// reasonable sample (brief: "amostra mínima razoável, ≥5 dias").
function computeHabitTaskCorrelations(lookbackDays = 30) {
  const results = [];
  for (const habit of state.habits) {
    const doneDays = [];
    const notDoneDays = [];
    for (let i = 0; i < lookbackDays; i++) {
      const dateStr = getLocalDateString(i);
      const tasksThatDay = getTasksCompletedOnDate(dateStr);
      (habit.history[dateStr] ? doneDays : notDoneDays).push(tasksThatDay);
    }
    if (doneDays.length < MIN_CORRELATION_SAMPLE_DAYS || notDoneDays.length < MIN_CORRELATION_SAMPLE_DAYS) continue;

    const avgDone = doneDays.reduce((a, b) => a + b, 0) / doneDays.length;
    const avgNotDone = notDoneDays.reduce((a, b) => a + b, 0) / notDoneDays.length;
    if (avgDone === avgNotDone) continue;

    const percentDiff = avgNotDone === 0 ? null : Math.round(((avgDone - avgNotDone) / avgNotDone) * 100);
    results.push({ habit, avgDone, avgNotDone, percentDiff, sampleDone: doneDays.length, sampleNotDone: notDoneDays.length });
  }
  results.sort((a, b) => Math.abs(b.avgDone - b.avgNotDone) - Math.abs(a.avgDone - a.avgNotDone));
  return results;
}

// Tasks that have been rescheduled 3+ times or have sat pending for 14+ days
function getZombieTasks() {
  return state.tasks.filter(t => {
    if (t.completed) return false;
    const ageDays = (Date.now() - getTaskCreatedAt(t)) / 86400000;
    return (t.rescheduleCount || 0) >= ZOMBIE_RESCHEDULE_THRESHOLD || ageDays >= ZOMBIE_AGE_DAYS_THRESHOLD;
  });
}

// Aggregate habit completion rate per weekday across all habits (last 14
// days) — missing entries count as "not done", same convention used
// elsewhere in the app (e.g. habit reminders).
function getHabitRateByWeekday(lookbackDays = 14) {
  if (state.habits.length === 0) return [];
  const totals = new Array(7).fill(0);
  const completedCounts = new Array(7).fill(0);

  for (let i = 0; i < lookbackDays; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = formatDateLocal(d);
    for (const habit of state.habits) {
      totals[d.getDay()]++;
      if (habit.history[dateStr]) completedCounts[d.getDay()]++;
    }
  }

  return WEEKDAY_LABELS_SHORT.map((label, i) => ({
    label,
    rate: totals[i] > 0 ? Math.round((completedCounts[i] / totals[i]) * 100) : null
  }));
}

function getCreatedVsCompletedThisWeek() {
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  const created = state.tasks.filter(t => getTaskCreatedAt(t) >= sevenDaysAgo).length;
  const completed = state.tasks.filter(t => t.completed && t.completedAt && t.completedAt >= sevenDaysAgo).length;
  return { created, completed };
}

function buildWeeklyReport() {
  const tasksCompletedThisWeek = state.tasks.filter(t => t.completed).length;
  const totalTasks = state.tasks.length;

  const habitRates = state.habits.map(h => {
    let completed = 0;
    for (let i = 0; i < 7; i++) {
      if (h.history[getLocalDateString(i)]) completed++;
    }
    return completed / 7;
  });
  const avgHabitRate = habitRates.length > 0
    ? Math.round((habitRates.reduce((a, b) => a + b, 0) / habitRates.length) * 100)
    : 0;

  const bestStreak = state.habits.reduce((max, h) => Math.max(max, calculateStreak(h.history)), 0);
  const notesThisWeek = state.notes.filter(n => Date.now() - n.updatedAt <= 7 * 24 * 3600 * 1000).length;

  const moodEntries = getMoodTrendForLastDays(7);
  const avgMood = moodEntries.length > 0 ? moodEntries.reduce((a, b) => a + b, 0) / moodEntries.length : null;
  const avgMoodRounded = avgMood !== null ? Math.round(avgMood) : null;

  const correlations = computeHabitTaskCorrelations();
  const zombieTasks = getZombieTasks();
  const weekdayRates = getHabitRateByWeekday();
  const createdVsCompleted = getCreatedVsCompletedThisWeek();

  return {
    tasksCompletedThisWeek, totalTasks, avgHabitRate, bestStreak, notesThisWeek,
    avgMood, avgMoodRounded, moodEntries, correlations, zombieTasks, weekdayRates, createdVsCompleted
  };
}

// Deterministic fallback paragraph (used without an API key, or if the AI call fails)
function buildFallbackHighlight(report) {
  let highlight;
  if (report.totalTasks === 0 && state.habits.length === 0) {
    highlight = 'Comece adicionando algumas tarefas e hábitos para o Gênesis acompanhar sua evolução semanal.';
  } else if (report.avgHabitRate >= 70 && report.tasksCompletedThisWeek === report.totalTasks && report.totalTasks > 0) {
    highlight = `Semana forte: todas as tarefas concluídas e ${report.avgHabitRate}% de consistência nos hábitos.`;
  } else if (report.avgHabitRate >= 50 || report.tasksCompletedThisWeek > 0) {
    highlight = `${report.tasksCompletedThisWeek} tarefa(s) concluída(s) e ${report.avgHabitRate}% de consistência nos hábitos essa semana.`;
  } else {
    highlight = 'Semana mais devagar. Escolha 1 tarefa e 1 hábito para focar agora.';
  }
  if (report.createdVsCompleted.created > report.createdVsCompleted.completed + 2) {
    highlight += ` Você criou ${report.createdVsCompleted.created} tarefas essa semana mas concluiu só ${report.createdVsCompleted.completed} — pode estar se sobrecarregando.`;
  }
  if (report.zombieTasks.length > 0) {
    highlight += ` ${report.zombieTasks.length} tarefa(s) parada(s) há tempo pedem uma decisão.`;
  }
  return highlight;
}

async function generateAIWeeklySummary(report) {
  if (!state.apiKey) return null;

  const topCorrelation = report.correlations[0];
  const worstWeekday = report.weekdayRates.filter(w => w.rate !== null).sort((a, b) => a.rate - b.rate)[0];

  const dataLines = [
    `Tarefas: ${report.tasksCompletedThisWeek}/${report.totalTasks} concluídas no total; ${report.createdVsCompleted.created} criadas e ${report.createdVsCompleted.completed} concluídas nos últimos 7 dias.`,
    `Hábitos: consistência média de ${report.avgHabitRate}% (7d), melhor streak ${report.bestStreak}d.`,
    report.avgMood !== null ? `Humor médio (7d): ${report.avgMood.toFixed(1)}/5.` : 'Sem registros de humor.',
    topCorrelation ? `Correlação: nos dias com "${topCorrelation.habit.name}" feito, tarefas concluídas por dia ${topCorrelation.avgDone >= topCorrelation.avgNotDone ? 'sobem' : 'caem'} de ${topCorrelation.avgNotDone.toFixed(1)} para ${topCorrelation.avgDone.toFixed(1)}.` : null,
    report.zombieTasks.length > 0 ? `${report.zombieTasks.length} tarefa(s) "zumbi" (reagendadas 3+ vezes ou paradas 14+ dias).` : null,
    worstWeekday ? `Pior dia da semana para hábitos: ${worstWeekday.label} (${worstWeekday.rate}%).` : null
  ].filter(Boolean).join('\n');

  try {
    const response = await callGroq({
      messages: [
        { role: 'system', content: 'Você é o Gênesis. Escreva um único parágrafo curto (2-3 frases), direto, em português, analisando os números abaixo. Sem parabenização vazia, sem repetir os números literalmente — sintetize o que eles significam.' },
        { role: 'user', content: dataLines }
      ]
    });
    return response.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('Erro ao gerar resumo semanal com IA:', err);
    return null;
  }
}

function renderZombieTaskItem(task) {
  const ageDays = Math.floor((Date.now() - getTaskCreatedAt(task)) / 86400000);
  const reasons = [];
  if ((task.rescheduleCount || 0) >= ZOMBIE_RESCHEDULE_THRESHOLD) reasons.push(`reagendada ${task.rescheduleCount}x`);
  if (ageDays >= ZOMBIE_AGE_DAYS_THRESHOLD) reasons.push(`parada há ${ageDays}d`);

  return `
    <div class="zombie-task-item" data-id="${task.id}">
      <div class="zombie-task-info">
        <span class="zombie-task-title">${escapeHtml(task.title)}</span>
        <span class="zombie-task-reason">${reasons.join(', ')}</span>
      </div>
      <div class="zombie-task-actions">
        <button type="button" class="btn-icon zombie-do-now" title="Fazer agora (prioridade alta)">⚡</button>
        <button type="button" class="btn-icon zombie-breakdown" title="Quebrar em subtarefas com IA">✂️</button>
        <button type="button" class="btn-danger-icon zombie-delete" title="Excluir">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>
  `;
}

function wireZombieTaskActions() {
  document.querySelectorAll('.zombie-do-now').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.closest('.zombie-task-item').getAttribute('data-id');
      await executeFunctionCall('editar_tarefa', { id, prioridade: 'high' });
      document.getElementById('report-modal').classList.add('hidden');
      document.querySelector('.tab-btn[data-tab="tab-tasks"]').click();
    });
  });

  document.querySelectorAll('.zombie-breakdown').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const item = e.currentTarget.closest('.zombie-task-item');
      const id = item.getAttribute('data-id');
      const task = state.tasks.find(t => t.id === id);
      document.getElementById('report-modal').classList.add('hidden');
      if (task) handleSendMessage(`Quebre a tarefa "${task.title}" em 2 ou 3 subtarefas menores e mais específicas.`);
    });
  });

  document.querySelectorAll('.zombie-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.closest('.zombie-task-item').getAttribute('data-id');
      if (!confirm('Excluir esta tarefa?')) return;
      await executeFunctionCall('deletar_tarefa', { id });
      renderWeeklyReport();
    });
  });
}

export async function renderWeeklyReport() {
  const report = buildWeeklyReport();
  const body = document.getElementById('report-modal-body');

  const moodRow = report.avgMoodRounded !== null
    ? `<div class="report-stat-row">
        <span class="report-stat-label">${MOOD_EMOJIS[report.avgMoodRounded]} Humor médio da semana</span>
        <span class="report-stat-value">${MOOD_LABELS[report.avgMoodRounded]}</span>
      </div>`
    : `<div class="report-stat-row">
        <span class="report-stat-label">🙂 Humor da semana</span>
        <span class="report-stat-value" style="font-size:13px; color: var(--text-muted);">sem registros</span>
      </div>`;

  const createdVsCompletedRow = `
    <div class="report-stat-row">
      <span class="report-stat-label">📊 Criadas vs. concluídas (7d)</span>
      <span class="report-stat-value">${report.createdVsCompleted.created} / ${report.createdVsCompleted.completed}</span>
    </div>`;

  const correlationHtml = report.correlations.length > 0 ? `
    <div class="report-correlation">
      ${report.correlations.slice(0, 2).map(c => {
        const direction = c.avgDone >= c.avgNotDone ? 'mais' : 'menos';
        const diff = c.percentDiff !== null ? `${Math.abs(c.percentDiff)}%` : `${Math.abs(c.avgDone - c.avgNotDone).toFixed(1)} tarefas/dia`;
        return `<p>📈 Nos dias em que você marcou <strong>${escapeHtml(c.habit.name)}</strong>, concluiu <strong>${diff} ${direction}</strong> tarefas por dia (amostra: ${c.sampleDone} vs ${c.sampleNotDone} dias).</p>`;
      }).join('')}
    </div>` : '';

  const weekdayHtml = report.weekdayRates.length > 0 ? `
    <div class="report-weekday-rates">
      <div class="report-section-label">Consistência de hábitos por dia da semana (14d)</div>
      <div class="weekday-bars">
        ${report.weekdayRates.map(w => `
          <div class="weekday-bar-col">
            <div class="weekday-bar-track"><div class="weekday-bar-fill" style="height:${w.rate ?? 0}%"></div></div>
            <span class="weekday-bar-label">${w.label}</span>
            <span class="weekday-bar-value">${w.rate !== null ? w.rate + '%' : '-'}</span>
          </div>
        `).join('')}
      </div>
    </div>` : '';

  const zombieHtml = report.zombieTasks.length > 0 ? `
    <div class="report-zombie-section">
      <div class="report-section-label">⚠️ Isso importa mesmo? (${report.zombieTasks.length})</div>
      ${report.zombieTasks.map(renderZombieTaskItem).join('')}
    </div>` : '';

  body.innerHTML = `
    <div class="report-stat-row">
      <span class="report-stat-label">✅ Tarefas concluídas</span>
      <span class="report-stat-value">${report.tasksCompletedThisWeek}/${report.totalTasks}</span>
    </div>
    <div class="report-stat-row">
      <span class="report-stat-label">🔁 Consistência média de hábitos (7 dias)</span>
      <span class="report-stat-value">${report.avgHabitRate}%</span>
    </div>
    <div class="report-stat-row">
      <span class="report-stat-label">🔥 Melhor streak ativo</span>
      <span class="report-stat-value">${report.bestStreak} d</span>
    </div>
    <div class="report-stat-row">
      <span class="report-stat-label">📝 Notas atualizadas na semana</span>
      <span class="report-stat-value">${report.notesThisWeek}</span>
    </div>
    ${createdVsCompletedRow}
    ${moodRow}
    ${correlationHtml}
    ${weekdayHtml}
    ${zombieHtml}
    <div class="report-highlight" id="report-highlight-text">${buildFallbackHighlight(report)}</div>
  `;

  wireZombieTaskActions();

  if (state.apiKey) {
    const highlightEl = document.getElementById('report-highlight-text');
    highlightEl.textContent = 'Analisando seus números...';
    const aiSummary = await generateAIWeeklySummary(report);
    // Guard against the modal having been closed/reopened while awaiting
    const stillMounted = document.getElementById('report-highlight-text');
    if (stillMounted) stillMounted.innerHTML = aiSummary || buildFallbackHighlight(report);
  }
}

// Wires the weekly report modal open/close buttons
export function initReportUI() {
  const reportModal = document.getElementById('report-modal');
  document.getElementById('btn-weekly-report').addEventListener('click', () => {
    renderWeeklyReport();
    reportModal.classList.remove('hidden');
  });
  document.getElementById('btn-close-report-modal').addEventListener('click', () => {
    reportModal.classList.add('hidden');
  });
}
