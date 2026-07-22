/* ==========================================================================
   GÊNESIS - AGENT ACTION MEMORY (SUMMARY LABELS + SINGLE-LEVEL UNDO)
   ========================================================================== */

import { state } from '../state.js';
// Circular with agent/chat.js (chat importa o stack/summary daqui) — seguro
// em ESM porque todos os usos acontecem em tempo de execução.
import { saveChat } from './chat.js';

// Compact tallies for the "✓ 3 tarefas criadas, 1 reagendada" summary line
const ACTION_SUMMARY_LABELS = {
  criar_tarefa: n => `${n} tarefa${n > 1 ? 's' : ''} criada${n > 1 ? 's' : ''}`,
  concluir_tarefa: n => `${n} tarefa${n > 1 ? 's' : ''} concluída${n > 1 ? 's' : ''}`,
  reagendar_tarefa: n => `${n} tarefa${n > 1 ? 's' : ''} reagendada${n > 1 ? 's' : ''}`,
  editar_tarefa: n => `${n} tarefa${n > 1 ? 's' : ''} editada${n > 1 ? 's' : ''}`,
  deletar_tarefa: n => `${n} tarefa${n > 1 ? 's' : ''} excluída${n > 1 ? 's' : ''}`,
  criar_habito: n => `${n} hábito${n > 1 ? 's' : ''} criado${n > 1 ? 's' : ''}`,
  marcar_habito: n => `${n} hábito${n > 1 ? 's' : ''} marcado${n > 1 ? 's' : ''}`,
  deletar_habito: n => `${n} hábito${n > 1 ? 's' : ''} excluído${n > 1 ? 's' : ''}`,
  criar_nota: n => `${n} nota${n > 1 ? 's' : ''} criada${n > 1 ? 's' : ''}`,
  deletar_nota: n => `${n} nota${n > 1 ? 's' : ''} excluída${n > 1 ? 's' : ''}`,
  registrar_humor: () => 'humor registrado',
  lembrar_fato: n => `${n} fato${n > 1 ? 's' : ''} memorizado${n > 1 ? 's' : ''}`
};

export function formatActionSummary(executedToolNames) {
  const counts = {};
  for (const name of executedToolNames) counts[name] = (counts[name] || 0) + 1;
  const parts = Object.entries(counts)
    .filter(([name]) => ACTION_SUMMARY_LABELS[name])
    .map(([name, n]) => ACTION_SUMMARY_LABELS[name](n));
  return parts.length > 0 ? `✓ ${parts.join(', ')}` : '';
}

// Holds the undo closures for the most recently executed batch of AI
// actions (a single chat turn may run several tool calls) — single level,
// not a full history, matching "desfazer a última ação".
export let lastActionUndoStack = [];

// Imported ESM bindings are read-only for importers — writers (the tool loop
// in chat.js) go through this setter instead of assigning directly.
export function setLastActionUndoStack(stack) {
  lastActionUndoStack = stack;
}

export async function undoLastAction() {
  if (lastActionUndoStack.length === 0) return;
  const stack = lastActionUndoStack;
  lastActionUndoStack = [];

  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      await stack[i]();
    } catch (err) {
      console.error('Erro ao desfazer ação:', err);
    }
  }

  state.chatHistory.push({
    sender: 'agent',
    text: '↩️ Última ação desfeita.',
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  });
  saveChat();
}
