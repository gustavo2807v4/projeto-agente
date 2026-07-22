/* ==========================================================================
   GÊNESIS - QUICK CAPTURE (NATURAL LANGUAGE)
   ========================================================================== */

import { state } from '../state.js';
import { escapeHtml, stripDiacritics, formatDateLocal, getLocalDateString } from '../utils.js';
import { MOOD_EMOJIS } from './mood.js';
import { chatCompletion as callGroq } from '../agent/providers/groq.js';
import { executeFunctionCall } from '../agent/tools.js';

// Unaccented so \b word boundaries behave — JS's default (non-unicode) \b
// treats accented letters like "ã"/"ê" as non-word characters, so a pattern
// like /\bamanhã\b/ silently fails to match "amanhã," (boundary between two
// "non-word" characters never fires). Stripping diacritics before matching
// sidesteps the whole class of bugs instead of hand-tuning every regex.
const WEEKDAY_NAMES_PT = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

// Resolves common PT-BR relative date phrases client-side (cheap, instant,
// no API call needed for the trivial cases). Anything it doesn't recognize
// is left for the AI classifier to figure out from full-sentence context.
export function parseRelativeDatePT(text) {
  const lower = stripDiacritics(text.toLowerCase());
  const today = new Date();
  const addDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };

  if (/\bhoje\b/.test(lower)) return { date: formatDateLocal(today), matchedText: 'hoje' };
  if (/\bdepois de amanha\b/.test(lower)) return { date: formatDateLocal(addDays(2)), matchedText: 'depois de amanhã' };
  if (/\bamanha\b/.test(lower)) return { date: formatDateLocal(addDays(1)), matchedText: 'amanhã' };

  const daquiDias = lower.match(/daqui\s+(\d+)\s+dias?/);
  if (daquiDias) return { date: formatDateLocal(addDays(Number(daquiDias[1]))), matchedText: daquiDias[0] };

  const daquiSemanas = lower.match(/daqui\s+(\d+)\s+semanas?/);
  if (daquiSemanas) return { date: formatDateLocal(addDays(Number(daquiSemanas[1]) * 7)), matchedText: daquiSemanas[0] };

  if (/\bfim d[eo] mes\b/.test(lower)) {
    const d = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return { date: formatDateLocal(d), matchedText: 'fim do mês' };
  }

  if (/\bfim de semana\b/.test(lower)) {
    const d = new Date(today);
    const diff = (6 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return { date: formatDateLocal(d), matchedText: 'fim de semana' };
  }

  for (let i = 0; i < WEEKDAY_NAMES_PT.length; i++) {
    const name = WEEKDAY_NAMES_PT[i];
    if (new RegExp(`\\b${name}(-feira)?\\b`).test(lower)) {
      const d = new Date(today);
      let diff = (i - d.getDay() + 7) % 7;
      if (diff === 0) diff = 7; // a named weekday means the next occurrence, not today
      d.setDate(d.getDate() + diff);
      return { date: formatDateLocal(d), matchedText: name };
    }
  }

  return null;
}

const QUICK_CAPTURE_TOOL = {
  type: 'function',
  function: {
    name: 'classificar_captura',
    description: 'Classifica uma captura rápida em texto livre como tarefa, hábito, nota ou humor, e extrai os campos estruturados.',
    parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['tarefa', 'habito', 'nota', 'humor'] },
        titulo: { type: 'string', description: 'Título/nome extraído (tarefa, hábito ou nota)' },
        prioridade: { type: 'string', enum: ['low', 'medium', 'high'] },
        prazo: { type: 'string', description: 'YYYY-MM-DD se detectado, vazio se não houver' },
        conteudo: { type: 'string', description: 'Corpo da nota, se tipo=nota' },
        valor_humor: { type: 'integer', minimum: 1, maximum: 5, description: 'Se tipo=humor, 1=péssimo a 5=ótimo' }
      },
      required: ['tipo']
    }
  }
};

async function classifyQuickCaptureWithAI(text) {
  const dateHint = parseRelativeDatePT(text);
  const systemMsg = {
    role: 'system',
    content: `Você classifica capturas rápidas de um app de produtividade pessoal. Hoje é ${getLocalDateString(0)}. Sempre chame a função classificar_captura.${
      dateHint ? ` Detecção local sugere a data ${dateHint.date} para o trecho "${dateHint.matchedText}" — use-a se fizer sentido, ajuste se achar melhor.` : ''
    }`
  };

  const response = await callGroq({
    messages: [systemMsg, { role: 'user', content: text }],
    tools: [QUICK_CAPTURE_TOOL],
    tool_choice: { type: 'function', function: { name: 'classificar_captura' } }
  });

  const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error('A IA não retornou uma classificação.');
  return JSON.parse(toolCall.function.arguments || '{}');
}

// No-API-key fallback: simple keyword/regex heuristics so quick capture
// still works (less accurately) in simulated mode.
function classifyQuickCaptureLocally(text) {
  const lower = stripDiacritics(text.toLowerCase());
  const dateHint = parseRelativeDatePT(text);

  if (/^(ideia|nota|anota(r)?)\s*[:\-]/i.test(text)) {
    const content = text.replace(/^(ideia|nota|anota(r)?)\s*[:\-]\s*/i, '');
    return { tipo: 'nota', titulo: content.slice(0, 60), conteudo: content };
  }

  const hasFeelingTrigger = /\bhumor\b|me sinto|sentindo|\bestou\b/.test(lower);
  const moodWordMatch = lower.match(/\b(otimo|incrivel|maravilhoso|animado|bem|bom|feliz|mal|ruim|triste|pessimo|horrivel)\b/);
  if (hasFeelingTrigger && moodWordMatch) {
    const word = moodWordMatch[1];
    let valor = 3;
    if (/otimo|incrivel|maravilhoso|animado/.test(word)) valor = 5;
    else if (/bem|bom|feliz/.test(word)) valor = 4;
    else if (/mal|ruim|triste/.test(word)) valor = 2;
    else if (/pessimo|horrivel/.test(word)) valor = 1;
    return { tipo: 'humor', valor_humor: valor };
  }

  if (/^(h[áa]bito)\s*[:\-]/i.test(text)) {
    return { tipo: 'habito', titulo: text.replace(/^(h[áa]bito)\s*[:\-]\s*/i, '') };
  }

  let prioridade = 'medium';
  if (/urgente|prioridade alta|importante/.test(lower)) prioridade = 'high';
  else if (/sem pressa|quando der|prioridade baixa/.test(lower)) prioridade = 'low';

  return { tipo: 'tarefa', titulo: text, prioridade, prazo: dateHint ? dateHint.date : '' };
}

const QUICK_CAPTURE_TYPE_LABELS = { tarefa: 'Tarefa', habito: 'Hábito', nota: 'Nota', humor: 'Humor' };

function closeQuickCapturePreview() {
  const previewEl = document.getElementById('quick-capture-preview');
  previewEl.classList.add('hidden');
  previewEl.innerHTML = '';
}

function renderQuickCapturePreview(parsed, originalText) {
  const previewEl = document.getElementById('quick-capture-preview');
  const tipo = ['tarefa', 'habito', 'nota', 'humor'].includes(parsed.tipo) ? parsed.tipo : 'tarefa';

  let fieldsHtml = '';
  if (tipo === 'tarefa') {
    fieldsHtml = `
      <div class="form-row"><input type="text" id="qc-titulo" value="${escapeHtml(parsed.titulo || originalText)}" /></div>
      <div class="form-row flex-row">
        <div class="form-col">
          <label>Prioridade</label>
          <select id="qc-prioridade">
            <option value="low" ${parsed.prioridade === 'low' ? 'selected' : ''}>Baixa</option>
            <option value="medium" ${(!parsed.prioridade || parsed.prioridade === 'medium') ? 'selected' : ''}>Média</option>
            <option value="high" ${parsed.prioridade === 'high' ? 'selected' : ''}>Alta</option>
          </select>
        </div>
        <div class="form-col">
          <label>Prazo</label>
          <input type="date" id="qc-prazo" value="${parsed.prazo || ''}" />
        </div>
      </div>`;
  } else if (tipo === 'habito') {
    fieldsHtml = `<div class="form-row"><input type="text" id="qc-nome" value="${escapeHtml(parsed.titulo || originalText)}" /></div>`;
  } else if (tipo === 'nota') {
    fieldsHtml = `
      <div class="form-row"><input type="text" id="qc-titulo" value="${escapeHtml(parsed.titulo || 'Nova nota')}" /></div>
      <div class="form-row"><textarea id="qc-conteudo" rows="3">${escapeHtml(parsed.conteudo || originalText)}</textarea></div>`;
  } else if (tipo === 'humor') {
    const value = parsed.valor_humor || 3;
    fieldsHtml = `<div class="mood-options" id="qc-mood-options">${
      [1, 2, 3, 4, 5].map(v => `<button type="button" class="mood-btn qc-mood-btn ${v === value ? 'active' : ''}" data-mood="${v}">${MOOD_EMOJIS[v]}</button>`).join('')
    }</div>`;
  }

  previewEl.classList.remove('hidden');
  previewEl.innerHTML = `
    <div class="quick-capture-type-label">Detectado como: <strong>${QUICK_CAPTURE_TYPE_LABELS[tipo]}</strong></div>
    ${fieldsHtml}
    <div class="form-actions">
      <button type="button" id="qc-cancel" class="btn btn-secondary">Cancelar</button>
      <button type="button" id="qc-save" class="btn btn-primary">Salvar</button>
    </div>
  `;

  if (tipo === 'humor') {
    previewEl.querySelectorAll('.qc-mood-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        previewEl.querySelectorAll('.qc-mood-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  document.getElementById('qc-cancel').addEventListener('click', closeQuickCapturePreview);
  document.getElementById('qc-save').addEventListener('click', () => saveQuickCapture(tipo));
}

async function saveQuickCapture(tipo) {
  if (tipo === 'tarefa') {
    const titulo = document.getElementById('qc-titulo').value.trim();
    if (!titulo) return;
    await executeFunctionCall('criar_tarefa', {
      titulo,
      prioridade: document.getElementById('qc-prioridade').value,
      prazo: document.getElementById('qc-prazo').value
    });
  } else if (tipo === 'habito') {
    const nome = document.getElementById('qc-nome').value.trim();
    if (!nome) return;
    await executeFunctionCall('criar_habito', { nome });
  } else if (tipo === 'nota') {
    const titulo = document.getElementById('qc-titulo').value.trim();
    if (!titulo) return;
    await executeFunctionCall('criar_nota', { titulo, conteudo: document.getElementById('qc-conteudo').value });
  } else if (tipo === 'humor') {
    const activeBtn = document.querySelector('.qc-mood-btn.active');
    await executeFunctionCall('registrar_humor', { valor: activeBtn ? Number(activeBtn.getAttribute('data-mood')) : 3 });
  }

  closeQuickCapturePreview();
  document.getElementById('quick-capture-input').value = '';
}

async function handleQuickCapture(text) {
  if (!text.trim()) return;

  const previewEl = document.getElementById('quick-capture-preview');
  previewEl.classList.remove('hidden');
  previewEl.innerHTML = '<p class="search-empty-hint">Analisando...</p>';

  let parsed;
  try {
    parsed = state.apiKey ? await classifyQuickCaptureWithAI(text) : classifyQuickCaptureLocally(text);
  } catch (err) {
    console.error('Erro ao classificar captura rápida:', err);
    parsed = classifyQuickCaptureLocally(text);
  }

  renderQuickCapturePreview(parsed, text);
}

export function initQuickCapture() {
  const input = document.getElementById('quick-capture-input');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleQuickCapture(input.value);
    } else if (e.key === 'Escape') {
      closeQuickCapturePreview();
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  document.addEventListener('click', (e) => {
    const wrapper = document.querySelector('.quick-capture-wrapper');
    if (wrapper && !wrapper.contains(e.target)) closeQuickCapturePreview();
  });
}
