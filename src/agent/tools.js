/* ==========================================================================
   GÊNESIS - AGENT TOOLS (DEFINITIONS + EXECUTORS)
   ========================================================================== */

import { state } from '../state.js';
import { getLocalDateString } from '../utils.js';
import { saveTasks, spawnNextRecurrence } from '../features/tasks.js';
import { saveHabits } from '../features/habits.js';
import { saveNotes, searchNotes } from '../features/notes.js';
import { saveMoods, MOOD_LABELS } from '../features/mood.js';
import { deleteGoogleCalendarEvent, updateGoogleCalendarEventDate } from '../integrations/googleCalendar.js';

// Declares the actions the model is allowed to trigger directly on the user's workspace,
// in OpenAI-compatible tool-calling format (used by Groq's chat completions API).
// Tools take real IDs (exposed to the model via buildSystemInstruction's
// context snapshot) instead of fuzzy title/name matching — reliable even
// when two items have very similar names.
export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'criar_tarefa',
      description: 'Cria uma nova tarefa no painel do usuário.',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título da tarefa' },
          prioridade: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Prioridade da tarefa (padrão: medium)' },
          prazo: { type: 'string', description: 'Prazo no formato YYYY-MM-DD, se mencionado' },
          recorrencia: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Se a tarefa deve se repetir automaticamente após concluída (omita se não for recorrente)' }
        },
        required: ['titulo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'concluir_tarefa',
      description: 'Marca uma tarefa existente como concluída (ou reabre, se especificado), pelo id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id da tarefa' },
          concluido: { type: 'boolean', description: 'true para concluir, false para reabrir (padrão: true)' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reagendar_tarefa',
      description: 'Move o prazo de uma tarefa existente para uma nova data, pelo id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id da tarefa' },
          novo_prazo: { type: 'string', description: 'Novo prazo no formato YYYY-MM-DD (envie vazio para remover o prazo)' }
        },
        required: ['id', 'novo_prazo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'editar_tarefa',
      description: 'Edita título, prioridade, prazo e/ou recorrência de uma tarefa existente, pelo id. Envie apenas os campos que quer alterar.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id da tarefa a editar' },
          titulo: { type: 'string', description: 'Novo título, se for alterar' },
          prioridade: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Nova prioridade, se for alterar' },
          prazo: { type: 'string', description: 'Novo prazo no formato YYYY-MM-DD, se for alterar (envie vazio para remover)' },
          recorrencia: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'], description: 'Nova recorrência, se for alterar ("none" para parar de repetir)' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deletar_tarefa',
      description: 'Remove uma tarefa do painel, pelo id. Ação destrutiva — o usuário confirma antes de executar.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Id da tarefa' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'criar_habito',
      description: 'Cria um novo hábito para ser rastreado diariamente.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome do hábito' },
          frequencia: { type: 'string', description: 'Frequência desejada em texto livre (ex: "todo dia", "3x por semana"), apenas informativo por enquanto' }
        },
        required: ['nome']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'marcar_habito',
      description: 'Marca ou desmarca um hábito como concluído numa data, pelo id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id do hábito' },
          data: { type: 'string', description: 'Data no formato YYYY-MM-DD (padrão: hoje)' },
          concluido: { type: 'boolean', description: 'true para marcar como feito, false para desmarcar (padrão: true)' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deletar_habito',
      description: 'Remove um hábito rastreado, pelo id. Ação destrutiva — o usuário confirma antes de executar.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Id do hábito' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'criar_nota',
      description: 'Cria uma nova nota/anotação com título e conteúdo (Markdown suportado).',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título da nota' },
          conteudo: { type: 'string', description: 'Conteúdo da nota em Markdown' }
        },
        required: ['titulo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deletar_nota',
      description: 'Remove uma nota existente, pelo id. Ação destrutiva — o usuário confirma antes de executar.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Id da nota' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'buscar_notas',
      description: 'Busca notas por palavra-chave no título ou conteúdo. Use antes de responder perguntas sobre o conteúdo de notas específicas.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Termo de busca' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'registrar_humor',
      description: 'Registra o humor do usuário numa data, numa escala de 1 (péssimo) a 5 (ótimo).',
      parameters: {
        type: 'object',
        properties: {
          valor: { type: 'integer', minimum: 1, maximum: 5, description: '1=péssimo, 2=ruim, 3=neutro, 4=bom, 5=ótimo' },
          data: { type: 'string', description: 'Data no formato YYYY-MM-DD (padrão: hoje)' }
        },
        required: ['valor']
      }
    }
  }
];

// Tool calls that mutate destructively — the app always asks for explicit
// confirmation in a native dialog before executing these, regardless of how
// confident the model is. This is enforced in code, not just prompted for,
// so it can't be talked around by a persuasive user message.
export const DESTRUCTIVE_TOOLS = new Set(['deletar_tarefa', 'deletar_habito', 'deletar_nota']);

// Resolves a friendly description of what a destructive call is about to do,
// so the confirmation dialog names the actual item instead of a bare id.
export function describeDestructiveAction(name, args) {
  if (name === 'deletar_tarefa') {
    const task = state.tasks.find(t => t.id === args.id);
    return task ? `excluir a tarefa "${task.title}"` : null;
  }
  if (name === 'deletar_habito') {
    const habit = state.habits.find(h => h.id === args.id);
    return habit ? `excluir o hábito "${habit.name}"` : null;
  }
  if (name === 'deletar_nota') {
    const note = state.notes.find(n => n.id === args.id);
    return note ? `excluir a nota "${note.title}"` : null;
  }
  return null;
}

// Executes a single function call requested by the model against local state.
// Returns { status, message, undo? } — `undo`, when present, is an async
// closure that reverses exactly this mutation (used by the "desfazer última
// ação" chat button). Unknown ids are reported back as a normal error result
// so the model can recover (e.g. ask the user to clarify) instead of the
// whole tool loop breaking.
export async function executeFunctionCall(name, args) {
  switch (name) {
    case 'criar_tarefa': {
      const newTask = {
        id: 'task_' + Date.now(),
        title: args.titulo,
        priority: args.prioridade || 'medium',
        due: args.prazo || '',
        recurrence: args.recorrencia || '',
        completed: false,
        createdAt: Date.now(),
        rescheduleCount: 0
      };
      state.tasks.push(newTask);
      saveTasks();
      return {
        status: 'ok',
        message: `Tarefa "${newTask.title}" adicionada.`,
        undo: () => { state.tasks = state.tasks.filter(t => t.id !== newTask.id); saveTasks(); }
      };
    }
    case 'concluir_tarefa': {
      const task = state.tasks.find(t => t.id === args.id);
      if (!task) return { status: 'error', message: `Nenhuma tarefa encontrada com o id "${args.id}".` };

      const previousCompleted = task.completed;
      const previousCompletedAt = task.completedAt;
      task.completed = args.concluido !== undefined ? !!args.concluido : true;
      task.completedAt = task.completed ? Date.now() : undefined;

      let spawnedTask = null;
      if (task.completed && task.recurrence) {
        spawnNextRecurrence(task);
        spawnedTask = state.tasks[state.tasks.length - 1];
      }
      saveTasks();

      if (task.completed && task.gcalEventId) {
        const eventId = task.gcalEventId;
        task.gcalEventId = undefined;
        await deleteGoogleCalendarEvent(eventId);
        saveTasks();
      }

      return {
        status: 'ok',
        message: `Tarefa "${task.title}" marcada como ${task.completed ? 'concluída' : 'pendente'}.`,
        undo: () => {
          task.completed = previousCompleted;
          task.completedAt = previousCompletedAt;
          if (spawnedTask) state.tasks = state.tasks.filter(t => t.id !== spawnedTask.id);
          saveTasks();
        }
      };
    }
    case 'reagendar_tarefa': {
      const task = state.tasks.find(t => t.id === args.id);
      if (!task) return { status: 'error', message: `Nenhuma tarefa encontrada com o id "${args.id}".` };

      const previousDue = task.due;
      task.due = args.novo_prazo || '';
      task.rescheduleCount = (task.rescheduleCount || 0) + 1;
      saveTasks();

      if (task.gcalEventId) {
        if (task.due) await updateGoogleCalendarEventDate(task.gcalEventId, task.due);
        else { const eventId = task.gcalEventId; task.gcalEventId = undefined; saveTasks(); await deleteGoogleCalendarEvent(eventId); }
      }

      return {
        status: 'ok',
        message: `Tarefa "${task.title}" reagendada para ${task.due || 'sem prazo'}.`,
        undo: () => { task.due = previousDue; task.rescheduleCount = Math.max(0, (task.rescheduleCount || 0) - 1); saveTasks(); }
      };
    }
    case 'editar_tarefa': {
      const task = state.tasks.find(t => t.id === args.id);
      if (!task) return { status: 'error', message: `Nenhuma tarefa encontrada com o id "${args.id}".` };

      const previous = { title: task.title, priority: task.priority, due: task.due, recurrence: task.recurrence, rescheduleCount: task.rescheduleCount || 0 };
      const dueChanged = args.prazo !== undefined && args.prazo !== task.due;

      if (args.titulo) task.title = args.titulo;
      if (args.prioridade) task.priority = args.prioridade;
      if (args.prazo !== undefined) task.due = args.prazo;
      if (args.recorrencia !== undefined) task.recurrence = args.recorrencia === 'none' ? '' : args.recorrencia;
      if (dueChanged) task.rescheduleCount = (task.rescheduleCount || 0) + 1;
      saveTasks();

      if (dueChanged && task.gcalEventId) {
        if (task.due) await updateGoogleCalendarEventDate(task.gcalEventId, task.due);
        else { const eventId = task.gcalEventId; task.gcalEventId = undefined; saveTasks(); await deleteGoogleCalendarEvent(eventId); }
      }

      return {
        status: 'ok',
        message: `Tarefa "${task.title}" atualizada.`,
        undo: () => { Object.assign(task, previous); saveTasks(); }
      };
    }
    case 'deletar_tarefa': {
      const task = state.tasks.find(t => t.id === args.id);
      if (!task) return { status: 'error', message: `Nenhuma tarefa encontrada com o id "${args.id}".` };
      const eventId = task.gcalEventId;
      state.tasks = state.tasks.filter(t => t.id !== task.id);
      saveTasks();
      if (eventId) await deleteGoogleCalendarEvent(eventId);
      return {
        status: 'ok',
        message: `Tarefa "${task.title}" removida.`,
        undo: () => { state.tasks.push(task); saveTasks(); }
      };
    }
    case 'criar_habito': {
      const newHabit = { id: 'habit_' + Date.now(), name: args.nome, history: {} };
      state.habits.push(newHabit);
      saveHabits();
      return {
        status: 'ok',
        message: `Hábito "${newHabit.name}" criado.`,
        undo: () => { state.habits = state.habits.filter(h => h.id !== newHabit.id); saveHabits(); }
      };
    }
    case 'marcar_habito': {
      const habit = state.habits.find(h => h.id === args.id);
      if (!habit) return { status: 'error', message: `Nenhum hábito encontrado com o id "${args.id}".` };

      const date = args.data || getLocalDateString(0);
      const previousValue = habit.history[date];
      const completed = args.concluido !== undefined ? !!args.concluido : true;
      habit.history[date] = completed;
      saveHabits();

      return {
        status: 'ok',
        message: `Hábito "${habit.name}" ${completed ? 'marcado como feito' : 'desmarcado'} em ${date}.`,
        undo: () => {
          if (previousValue === undefined) delete habit.history[date];
          else habit.history[date] = previousValue;
          saveHabits();
        }
      };
    }
    case 'deletar_habito': {
      const habit = state.habits.find(h => h.id === args.id);
      if (!habit) return { status: 'error', message: `Nenhum hábito encontrado com o id "${args.id}".` };
      state.habits = state.habits.filter(h => h.id !== habit.id);
      saveHabits();
      return {
        status: 'ok',
        message: `Hábito "${habit.name}" removido.`,
        undo: () => { state.habits.push(habit); saveHabits(); }
      };
    }
    case 'criar_nota': {
      const newNote = { id: 'note_' + Date.now(), title: args.titulo, body: args.conteudo || '', updatedAt: Date.now() };
      state.notes.push(newNote);
      state.activeNoteId = newNote.id;
      saveNotes();
      return {
        status: 'ok',
        message: `Nota "${newNote.title}" criada.`,
        undo: () => { state.notes = state.notes.filter(n => n.id !== newNote.id); saveNotes(); }
      };
    }
    case 'deletar_nota': {
      const note = state.notes.find(n => n.id === args.id);
      if (!note) return { status: 'error', message: `Nenhuma nota encontrada com o id "${args.id}".` };
      state.notes = state.notes.filter(n => n.id !== note.id);
      if (state.activeNoteId === note.id) {
        state.activeNoteId = state.notes.length > 0 ? state.notes[0].id : null;
      }
      saveNotes();
      return {
        status: 'ok',
        message: `Nota "${note.title}" removida.`,
        undo: () => { state.notes.push(note); saveNotes(); }
      };
    }
    case 'buscar_notas': {
      const matches = searchNotes(args.query);
      if (matches.length === 0) {
        return { status: 'ok', message: `Nenhuma nota encontrada para "${args.query}".`, results: [] };
      }
      return {
        status: 'ok',
        message: `${matches.length} nota(s) encontrada(s).`,
        results: matches.map(n => ({ id: n.id, titulo: n.title, trecho: (n.body || '').slice(0, 200) }))
      };
    }
    case 'registrar_humor': {
      const date = args.data || getLocalDateString(0);
      const value = Math.max(1, Math.min(5, Math.round(args.valor)));
      const previousValue = state.moods[date];
      state.moods[date] = value;
      saveMoods();
      return {
        status: 'ok',
        message: `Humor de ${date} registrado como "${MOOD_LABELS[value]}".`,
        undo: () => {
          if (previousValue === undefined) delete state.moods[date];
          else state.moods[date] = previousValue;
          saveMoods();
        }
      };
    }
    default:
      return { status: 'error', message: `Função desconhecida: ${name}` };
  }
}
