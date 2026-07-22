/* ==========================================================================
   GÊNESIS - UTILITIES & CLOCK
   ========================================================================== */

export function initClock() {
  const timeEl = document.getElementById('current-time');
  const dateEl = document.getElementById('current-date');

  function update() {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString('pt-BR');

    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    dateEl.textContent = now.toLocaleDateString('pt-BR', options);
  }

  update();
  setInterval(update, 1000);
}

// Formats a Date using its LOCAL calendar day (not toISOString, which converts
// to UTC and rolls over to the next day in the evening for negative-offset
// timezones like Brazil's — e.g. after 9pm BRT, toISOString() already reads
// as tomorrow).
export function formatDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper to format Date string (YYYY-MM-DD) relative to today, in local time
export function getLocalDateString(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return formatDateLocal(d);
}

export const RECURRENCE_LABELS = { daily: 'Diária', weekly: 'Semanal', monthly: 'Mensal' };

// Computes the next due date for a recurring task, based on its current due
// date (or today, if it had none) and its recurrence interval.
export function computeNextDueDate(dueStr, recurrence) {
  const base = dueStr ? new Date(dueStr + 'T00:00:00') : new Date();
  if (recurrence === 'daily') base.setDate(base.getDate() + 1);
  else if (recurrence === 'weekly') base.setDate(base.getDate() + 7);
  else if (recurrence === 'monthly') base.setMonth(base.getMonth() + 1);
  return formatDateLocal(base);
}

// Basic Markdown Parser
export function parseMarkdown(text) {
  if (!text) return '';
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  let inBlockquote = false;

  for (let line of lines) {
    let cleanLine = line.trim();

    // List item
    if (cleanLine.startsWith('- ') || cleanLine.startsWith('* ')) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      let content = cleanLine.substring(2);
      html += `<li>${parseInlineMarkdown(content)}</li>`;
      continue;
    } else if (inList && !cleanLine.startsWith('- ') && !cleanLine.startsWith('* ')) {
      html += '</ul>';
      inList = false;
    }

    // Blockquote
    if (cleanLine.startsWith('> ')) {
      if (!inBlockquote) {
        html += '<blockquote>';
        inBlockquote = true;
      }
      let content = cleanLine.substring(2);
      html += `<p>${parseInlineMarkdown(content)}</p>`;
      continue;
    } else if (inBlockquote && !cleanLine.startsWith('> ')) {
      html += '</blockquote>';
      inBlockquote = false;
    }

    // Headers
    if (cleanLine.startsWith('### ')) {
      html += `<h3>${parseInlineMarkdown(cleanLine.substring(4))}</h3>`;
    } else if (cleanLine.startsWith('## ')) {
      html += `<h2>${parseInlineMarkdown(cleanLine.substring(3))}</h2>`;
    } else if (cleanLine.startsWith('# ')) {
      html += `<h1>${parseInlineMarkdown(cleanLine.substring(2))}</h1>`;
    } else if (cleanLine === '') {
      html += '<br>';
    } else {
      html += `<p>${parseInlineMarkdown(cleanLine)}</p>`;
    }
  }

  if (inList) html += '</ul>';
  if (inBlockquote) html += '</blockquote>';

  return html;
}

function parseInlineMarkdown(text) {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // Inline Code
  html = html.replace(/`(.*?)`/g, '<code>$1</code>');
  return html;
}

// Calculate Habit Streak
export function calculateStreak(history) {
  if (!history || Object.keys(history).length === 0) return 0;

  let streak = 0;
  let checkDate = new Date();

  const formatDate = (date) => formatDateLocal(date);

  let todayStr = formatDate(checkDate);
  let yesterday = new Date();
  yesterday.setDate(checkDate.getDate() - 1);
  let yesterdayStr = formatDate(yesterday);

  // If completed today
  if (history[todayStr]) {
    streak = 1;
    checkDate.setDate(checkDate.getDate() - 1);
    while (true) {
      let dateStr = formatDate(checkDate);
      if (history[dateStr]) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
  }
  // If not completed today, but completed yesterday (streak is still alive)
  else if (history[yesterdayStr]) {
    streak = 1;
    checkDate.setDate(checkDate.getDate() - 2);
    while (true) {
      let dateStr = formatDate(checkDate);
      if (history[dateStr]) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
  }

  return streak;
}

export function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
