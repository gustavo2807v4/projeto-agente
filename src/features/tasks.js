/* ==========================================================================
   GÊNESIS - TASKS (CRUD, RENDER & FORM HANDLERS)
   ========================================================================== */

import * as localDb from '../db.js';
import { state, updateStats } from '../state.js';
import { escapeHtml, RECURRENCE_LABELS, computeNextDueDate } from '../utils.js';
import { queueCloudPush } from '../integrations/cloudSync.js';
import { deleteGoogleCalendarEvent, updateGoogleCalendarEventDate } from '../integrations/googleCalendar.js';

// Save helper — the IndexedDB write happens in the background (fire-and-
// forget with error logging); render + stats update immediately from the
// in-memory state so the UI never waits on the write.
export function saveTasks() {
  localDb.saveTasks(state.tasks).catch(err => console.error('Erro ao salvar tarefas:', err));
  renderTasks();
  updateStats();
  queueCloudPush();
}

// Opens the task form pre-filled with an existing task's data, in edit mode
function openTaskFormForEdit(task) {
  state.editingTaskId = task.id;
  const form = document.getElementById('task-form');
  document.getElementById('task-title').value = task.title;
  document.getElementById('task-priority').value = task.priority;
  document.getElementById('task-due').value = task.due || '';
  document.getElementById('task-recurrence').value = task.recurrence || '';
  form.classList.remove('hidden');
  form.querySelector('button[type="submit"]').textContent = 'Salvar Alterações';
  document.getElementById('task-title').focus();
}

// Tasks created before this field existed won't have it — fall back to the
// timestamp embedded in the id (`task_<epoch ms>`), or 0 as a last resort.
export function getTaskCreatedAt(task) {
  if (task.createdAt) return task.createdAt;
  const match = /^task_(\d+)$/.exec(task.id);
  return match ? Number(match[1]) : 0;
}

// Creates the next occurrence of a recurring task once the current one is completed
export function spawnNextRecurrence(task) {
  state.tasks.push({
    id: 'task_' + Date.now(),
    title: task.title,
    priority: task.priority,
    due: computeNextDueDate(task.due, task.recurrence),
    completed: false,
    recurrence: task.recurrence,
    createdAt: Date.now(),
    rescheduleCount: 0
  });
}

// Task Rendering
export function renderTasks() {
  const container = document.getElementById('task-list-container');
  container.innerHTML = '';

  let filtered = state.tasks;
  if (state.taskFilter === 'pending') {
    filtered = state.tasks.filter(t => !t.completed);
  } else if (state.taskFilter === 'completed') {
    filtered = state.tasks.filter(t => t.completed);
  }

  if (filtered.length === 0) {
    container.innerHTML = '<div class="notes-empty-state"><p>Nenhuma tarefa encontrada.</p></div>';
    return;
  }

  // Sort by priority (high > medium > low) and completed status
  filtered.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const priorityWeight = { high: 3, medium: 2, low: 1 };
    return priorityWeight[b.priority] - priorityWeight[a.priority];
  });

  filtered.forEach(task => {
    const item = document.createElement('div');
    item.className = `task-item ${task.completed ? 'completed' : ''}`;

    const formattedDate = task.due ? new Date(task.due + 'T00:00:00').toLocaleDateString('pt-BR', {day: 'numeric', month: 'short'}) : '';

    item.innerHTML = `
      <div class="task-item-left">
        <div class="custom-checkbox ${task.completed ? 'checked' : ''}" data-id="${task.id}"></div>
        <div class="task-details">
          <span class="task-title">${escapeHtml(task.title)}</span>
          <div class="task-meta">
            <span class="task-priority-badge priority-${task.priority}">${task.priority === 'high' ? 'Alta' : task.priority === 'medium' ? 'Média' : 'Baixa'}</span>
            ${task.due ? `<span class="task-due-date">📅 ${formattedDate}</span>` : ''}
            ${task.recurrence ? `<span class="task-recurrence-badge">🔁 ${RECURRENCE_LABELS[task.recurrence] || task.recurrence}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="task-item-right">
        <button class="btn-icon btn-edit-task" data-id="${task.id}" title="Editar tarefa">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="btn-danger-icon btn-delete-task" data-id="${task.id}" title="Excluir tarefa">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;

    // Edit listener — reopens the task form pre-filled, in edit mode
    item.querySelector('.btn-edit-task').addEventListener('click', () => {
      openTaskFormForEdit(task);
    });

    // Toggle complete listener — also clears the task off Google Agenda and
    // spawns the next occurrence, if the task recurs
    item.querySelector('.custom-checkbox').addEventListener('click', async () => {
      task.completed = !task.completed;
      task.completedAt = task.completed ? Date.now() : undefined;
      if (task.completed && task.recurrence) {
        spawnNextRecurrence(task);
      }
      saveTasks();
      if (task.completed && task.gcalEventId) {
        const eventId = task.gcalEventId;
        task.gcalEventId = undefined;
        await deleteGoogleCalendarEvent(eventId);
        saveTasks();
      }
    });

    // Delete listener — also removes the synced Google Agenda event, if any
    item.querySelector('.btn-delete-task').addEventListener('click', async () => {
      const eventId = task.gcalEventId;
      state.tasks = state.tasks.filter(t => t.id !== task.id);
      saveTasks();
      if (eventId) await deleteGoogleCalendarEvent(eventId);
    });

    container.appendChild(item);
  });
}

// Wires the task form (create/edit), its toggle buttons and the filter bar
export function initTasksUI() {
  const taskForm = document.getElementById('task-form');
  const taskFormSubmitBtn = taskForm.querySelector('button[type="submit"]');

  document.getElementById('btn-open-task-form').addEventListener('click', () => {
    const wasHidden = taskForm.classList.contains('hidden');
    state.editingTaskId = null;
    taskFormSubmitBtn.textContent = 'Salvar';
    if (wasHidden) {
      taskForm.reset();
      taskForm.classList.remove('hidden');
      document.getElementById('task-title').focus();
    } else {
      taskForm.classList.add('hidden');
    }
  });

  document.getElementById('btn-cancel-task').addEventListener('click', () => {
    taskForm.classList.add('hidden');
    taskForm.reset();
    state.editingTaskId = null;
    taskFormSubmitBtn.textContent = 'Salvar';
  });

  // Add/Edit Task submit
  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('task-title').value.trim();
    const priority = document.getElementById('task-priority').value;
    const due = document.getElementById('task-due').value;
    const recurrence = document.getElementById('task-recurrence').value;

    if (!title) return;

    if (state.editingTaskId) {
      const task = state.tasks.find(t => t.id === state.editingTaskId);
      if (task) {
        const dueChanged = task.due !== due;
        task.title = title;
        task.priority = priority;
        task.due = due;
        task.recurrence = recurrence;
        if (dueChanged) task.rescheduleCount = (task.rescheduleCount || 0) + 1;
        saveTasks();
        if (dueChanged && task.gcalEventId) {
          if (due) {
            await updateGoogleCalendarEventDate(task.gcalEventId, due);
          } else {
            const eventId = task.gcalEventId;
            task.gcalEventId = undefined;
            saveTasks();
            await deleteGoogleCalendarEvent(eventId);
          }
        }
      }
      state.editingTaskId = null;
    } else {
      const newTask = {
        id: 'task_' + Date.now(),
        title,
        priority,
        due,
        recurrence,
        completed: false,
        createdAt: Date.now(),
        rescheduleCount: 0
      };
      state.tasks.push(newTask);
      saveTasks();
    }

    // Reset and hide form
    taskForm.reset();
    taskForm.classList.add('hidden');
    taskFormSubmitBtn.textContent = 'Salvar';
  });

  // Task Filters
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      state.taskFilter = e.currentTarget.getAttribute('data-filter');
      renderTasks();
    });
  });
}
