/* ==========================================================================
   GÊNESIS - GROQ API CLIENT (MODEL FALLBACK + TOOL-CALL RECOVERY)
   ========================================================================== */

import { state } from '../state.js';

// Tries models in order — if one is deprecated/unavailable on the account,
// we fall back instead of failing outright.
const GROQ_MODEL_CANDIDATES = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

// Groq/Llama tool calling occasionally "leaks" the function call as plain
// text in this pseudo-XML shape instead of the structured tool_calls field
// (a known quirk, not specific to our prompt) — e.g.:
//   <function=reagendar_tarefa{"id": "task_123", "novo_prazo": "2026-07-17"}</function>
// Rather than surfacing a hard error to the user for something the model
// itself botched, we parse it back into the same shape a well-formed
// response would have, so the rest of the tool loop can't tell the
// difference.
function parseLeakedFunctionCalls(text) {
  const regex = /<function=([a-zA-Z_][a-zA-Z0-9_]*)(\{.*?\})<\/function>/gs;
  const calls = [];
  let match;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    try {
      const args = JSON.parse(match[2]);
      calls.push({ id: `leaked_${i++}_${Date.now()}`, type: 'function', function: { name: match[1], arguments: JSON.stringify(args) } });
    } catch {
      // malformed JSON in the leaked call — skip it rather than crash the loop
    }
  }
  return calls;
}

async function callGroqWithModel(model, body) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.apiKey}`
    },
    body: JSON.stringify({ model, ...body })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);

    if (response.status === 400) {
      try {
        const errJson = JSON.parse(errText);
        const failedGeneration = errJson?.error?.failed_generation;
        if (errJson?.error?.code === 'tool_use_failed' && failedGeneration) {
          const recovered = parseLeakedFunctionCalls(failedGeneration);
          if (recovered.length > 0) {
            return { choices: [{ message: { role: 'assistant', content: null, tool_calls: recovered } }] };
          }
        }
      } catch {
        // errText wasn't the expected JSON shape — fall through to the generic error below
      }
    }

    const err = new Error(`${response.status} ${response.statusText} - ${errText}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

// Tries each candidate model in order, moving to the next one on a rate-limit
// error (429) or an unavailable-model error (404). Remembers the last model
// that worked so subsequent calls in the same session skip straight to it.
let lastWorkingModel = null;

export async function callGroq(body) {
  const candidates = lastWorkingModel
    ? [lastWorkingModel, ...GROQ_MODEL_CANDIDATES.filter(m => m !== lastWorkingModel)]
    : GROQ_MODEL_CANDIDATES;

  let lastError;
  for (const model of candidates) {
    try {
      const result = await callGroqWithModel(model, body);
      lastWorkingModel = model;
      return result;
    } catch (err) {
      lastError = err;
      if (err.status === 429 || err.status === 404) continue;
      throw err;
    }
  }
  throw lastError;
}
