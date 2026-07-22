/* ==========================================================================
   GÊNESIS - MODEL ROUTER (REGRAS FIXAS, SEM LLM)
   ==========================================================================
   Decide qual modelo atende cada chamada do chat ANTES de chamar o LLM.
   Função pura e síncrona — custo zero, previsível, testável isolada.
   A captura rápida NÃO passa por aqui: ela importa o provider Groq direto
   (caminho quente, latência zero adicionada). */

export const PROVIDERS = {
  GROQ: 'groq',
  STRONG: 'strong'
};

// --------------------------------------------------------------------------
// Limiares/critérios — ajuste aqui, não dentro das regras.
// Todos os padrões casam sobre o texto minúsculo e SEM acentos (ver
// stripDiacriticsLocal abaixo), então escreva-os sem acento.
// --------------------------------------------------------------------------

// Tools cujo retorno exige síntese pelo modelo forte. Hoje só a futura
// buscar_historico (camada de memória) — a regra fica inerte até ela existir.
export const SYNTHESIS_TOOLS = new Set(['buscar_historico']);

// Intenção de recuperação de histórico — o turno vai precisar sintetizar
// contexto antigo mesmo antes de qualquer tool rodar.
const RETRIEVAL_INTENT_PATTERNS = [
  /\bo que (eu )?(tinha|havia) (decidido|falado|dito|anotado|combinado)\b/,
  /\b(lembra|lembre|recorda|relembra)\b/,
  /\bquando (foi|eu)\b/,
  /\bhistorico\b/,
  /\bda ultima vez\b/,
  /\bsemana passada\b|\bmes passado\b/
];

// Saudações e acks curtos — resposta mecânica, Groq resolve.
const GREETING_PATTERNS = [
  /^(oi|ola|opa|eai|e ai|hey|bom dia|boa tarde|boa noite)[!.?\s]*$/,
  /^(valeu|obrigado|obrigada|vlw|blz|beleza|ok|show|top|joia|boa)[!.?\s]*$/,
  /^(tchau|ate mais|ate logo|falou|flw)[!.?\s]*$/
];
// Acima deste tamanho a mensagem deixa de ser tratável como saudação.
const GREETING_MAX_LENGTH = 40;

// Verbos que indicam ação mecânica clara (tool routing puro) — o modelo só
// precisa mapear a frase para uma tool com id; Groq é rápido e suficiente.
const ACTION_INTENT_PATTERNS = [
  /\b(cria|criar|crie|adiciona|adicionar|adicione|anota|anotar|anote|registra|registrar|registre)\b/,
  /\b(conclui|concluir|conclua|finaliza|finalizar|finalize|termina|terminar|termine|fecha|fechar|feche)\b/,
  /\b(marca|marcar|marque|desmarca|desmarcar|desmarque)\b/,
  /\b(reagenda|reagendar|reagende|adia|adiar|adie|move|mover|mova|muda|mudar|mude|edita|editar|edite|renomeia|renomear|renomeie|altera|alterar|altere)\b/,
  /\b(apaga|apagar|apague|deleta|deletar|delete|remove|remover|remova|exclui|excluir|exclua|limpa|limpar|limpe)\b/
];

// --------------------------------------------------------------------------

// Local (sem importar utils.js) para manter o módulo 100% puro/autônomo.
function stripDiacriticsLocal(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Decide o modelo para UMA chamada ao LLM. Chamada a cada round do loop de
// tool calling — `executedToolNames` permite o upgrade meio-de-loop (round
// de síntese após buscar_historico vai pro forte).
//
// Precedência (primeira regra que casa vence):
//   1. modo fora do chat (captura/relatório/classificação) -> groq
//   2. round após tool de síntese (buscar_historico)        -> strong
//   3. intenção de recuperar histórico                      -> strong
//   4. saudação/ack curto                                   -> groq
//   5. ação mecânica clara (tool routing puro)              -> groq
//   6. conversa aberta no chat (modo "sócio")               -> strong
//   7. default (nada casou: modo desconhecido, texto vazio) -> groq
export function pickModel({ mode, messageText, executedToolNames } = {}) {
  // 1. Só o chat roteia pro modelo forte.
  if (mode !== 'chat') {
    return { provider: PROVIDERS.GROQ, reason: 'modo fora do chat' };
  }

  // 2. Upgrade meio-de-loop: já rodou uma tool cujo retorno exige síntese.
  const executed = executedToolNames || [];
  if (executed.some(name => SYNTHESIS_TOOLS.has(name))) {
    return { provider: PROVIDERS.STRONG, reason: 'síntese pós-busca de histórico' };
  }

  const text = stripDiacriticsLocal((messageText || '').trim().toLowerCase());
  if (!text) {
    return { provider: PROVIDERS.GROQ, reason: 'default (texto vazio)' };
  }

  // 3. Intenção de recuperação de histórico.
  if (RETRIEVAL_INTENT_PATTERNS.some(p => p.test(text))) {
    return { provider: PROVIDERS.STRONG, reason: 'intenção de recuperar histórico' };
  }

  // 4. Saudação/ack curto.
  if (text.length <= GREETING_MAX_LENGTH && GREETING_PATTERNS.some(p => p.test(text))) {
    return { provider: PROVIDERS.GROQ, reason: 'saudação/ack' };
  }

  // 5. Ação mecânica clara.
  if (ACTION_INTENT_PATTERNS.some(p => p.test(text))) {
    return { provider: PROVIDERS.GROQ, reason: 'ação mecânica (tool routing)' };
  }

  // 6. Conversa aberta no chat.
  return { provider: PROVIDERS.STRONG, reason: 'conversa aberta' };
}
