import type Anthropic from '@anthropic-ai/sdk';
import type { AlertService } from '../alerts/service.js';
import type { Db } from '../db/connection.js';
import { formatBRL } from '../domain/money.js';
import { getCustomer } from '../store/customers.js';
import { latestOpenDraft, markDraftsPresented } from '../store/drafts.js';
import { insertMessage, lastCustomerMessageAt, recentMessages, type StoredMessage } from '../store/messages.js';
import type { createOutbox } from '../whatsapp/outbox.js';
import { SYSTEM_PROMPT } from './prompt.js';
import type { ToolContext } from './tool-handlers.js';
import { buildTools } from './tools.js';

type MessageParam = Anthropic.Beta.BetaMessageParam;

const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const ALERT_INTERVAL_MS = 10 * 60 * 1000;
const DONO_PREFIX = '(mensagem do dono da revenda) ';
const DESCULPA = 'Desculpa, tive um probleminha aqui. Já avisei a revenda e logo alguém te responde.';

/** Colchetes marcam avisos do sistema; o cliente não pode forjar um. */
const unbracket = (t: string): string => t.replaceAll('[', '(').replaceAll(']', ')');

function toParam(msg: StoredMessage): { role: MessageParam['role']; text: string } {
  if (msg.tipo === 'sistema') return { role: 'user', text: `[${msg.texto}]` };
  if (msg.autor === 'cliente') return { role: 'user', text: unbracket(msg.texto) };
  if (msg.autor === 'dono') return { role: 'assistant', text: DONO_PREFIX + msg.texto };
  return { role: 'assistant', text: msg.texto };
}

/** Histórico no formato da API; `[]` quando a última fala não é do cliente (não há o que responder). */
export function buildHistory(msgs: StoredMessage[]): MessageParam[] {
  const out: { role: MessageParam['role']; content: string }[] = [];
  for (const msg of msgs) {
    const { role, text } = toParam(msg);
    const prev = out.at(-1);
    if (prev && prev.role === role) prev.content += `\n${text}`;
    else out.push({ role, content: text });
  }
  if (out.at(-1)?.role !== 'user') return [];
  if (out[0]!.role === 'assistant') out.unshift({ role: 'user', content: '[conversa iniciada pela revenda]' });
  return out;
}

/** Respostas cortadas ou que ainda pediam ferramenta não vão ao cliente. */
const INCOMPLETE: ReadonlySet<Anthropic.Beta.BetaStopReason> = new Set(['refusal', 'max_tokens', 'tool_use']);

export function extractReply(m: Anthropic.Beta.BetaMessage): string | null {
  if (m.stop_reason !== null && INCOMPLETE.has(m.stop_reason)) return null;
  const text = m.content
    .flatMap((b) => (b.type === 'text' ? [b.text.trim()] : []))
    .filter((t) => t !== '')
    .join('\n');
  return text === '' ? null : text;
}

/**
 * O histórico que o modelo recebe é só texto: ele não vê as chamadas de ferramenta dos turnos anteriores, então
 * não sabe o `rascunhoId` do resumo que o cliente acabou de ver. Sem ele, ao receber o "sim" o modelo prepara o
 * pedido de novo, em vez de confirmar, e o cliente fica preso num ciclo de resumos. Este aviso devolve o número.
 * Só aparece quando o cliente de fato viu o resumo antes da mensagem dele (a mesma regra de confirmar_pedido).
 */
export function openDraftNote(db: Db, clienteId: number, ultimaMensagemClienteEm: Date): string | null {
  const d = latestOpenDraft(db, clienteId);
  if (!d || d.apresentadoEm === null) return null;
  if (new Date(d.apresentadoEm).getTime() >= ultimaMensagemClienteEm.getTime()) return null;
  return (
    `Resumo aguardando confirmação: rascunhoId ${d.id}, total ${formatBRL(d.totalCentavos)}. O cliente já viu esse resumo. ` +
    'Se a última mensagem dele for um sim a esse resumo, chame confirmar_pedido com esse rascunhoId e NÃO chame preparar_pedido de novo. ' +
    'Se ele pedir qualquer mudança, aí sim chame preparar_pedido com os dados novos e mostre o novo resumo.'
  );
}

function historyFor(db: Db, clienteId: number, now: Date): MessageParam[] {
  return buildHistory(recentMessages(db, clienteId, new Date(now.getTime() - HISTORY_WINDOW_MS)));
}

/** Só nome, status HTTP e tipo do erro da API: nada da conversa. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'erro';
  const e = err as Error & { status?: unknown; type?: unknown };
  const parts = [err.name];
  if (typeof e.status === 'number') parts.push(`status=${e.status}`);
  if (typeof e.type === 'string') parts.push(`type=${e.type}`);
  return parts.join(' ');
}

export type AgentReply = { texto: string; opcoes?: string[] };

export interface Agent {
  reply(clienteId: number): Promise<AgentReply | null>;
}

export function createAgent(d: {
  client: Anthropic;
  model: string;
  effort: 'low' | 'medium' | 'high';
  db: Db;
  makeContext(clienteId: number): ToolContext;
  clock: () => Date;
}): Agent {
  async function reply(clienteId: number): Promise<AgentReply | null> {
    const messages = historyFor(d.db, clienteId, d.clock());
    if (messages.length === 0) return null;

    // Lido no começo do turno: um resumo enviado depois disso o cliente ainda não viu.
    const turno: NonNullable<ToolContext['turno']> = { escolha: null };
    const ctx: ToolContext = {
      ...d.makeContext(clienteId),
      ultimaMensagemClienteEm: lastCustomerMessageAt(d.db, clienteId) ?? new Date(0),
      turno,
    };
    const nota = openDraftNote(d.db, clienteId, ctx.ultimaMensagemClienteEm);
    const final = await d.client.beta.messages.toolRunner({
      model: d.model,
      max_tokens: 16000,
      system: nota ? [{ type: 'text', text: SYSTEM_PROMPT }, { type: 'text', text: nota }] : SYSTEM_PROMPT,
      tools: buildTools(ctx),
      messages,
      output_config: { effort: d.effort },
      cache_control: { type: 'ephemeral' },
      max_iterations: 10,
      // Sem thread no servidor: a conversa não fica guardada na Anthropic entre turnos (LGPD).
      thread: false,
    });
    // Depois de mostrar_opcoes o modelo costuma terminar sem texto: a mensagem do turno é a que foi à ferramenta.
    if (turno.escolha) return { texto: turno.escolha.mensagem, opcoes: turno.escolha.opcoes };
    const texto = extractReply(final);
    return texto === null ? null : { texto };
  }

  return { reply };
}

export function createCustomerTurnHandler(d: {
  db: Db;
  agent: Agent;
  outbox: ReturnType<typeof createOutbox>;
  alerts: AlertService;
  clock: () => Date;
}): (clienteId: number) => Promise<void> {
  const lastAlertAt = new Map<number, number>();

  const paused = (clienteId: number): boolean => {
    const c = getCustomer(d.db, clienteId);
    return !c || (c.botPausadoAte !== null && new Date(c.botPausadoAte).getTime() > d.clock().getTime());
  };

  async function alertOnce(clienteId: number, resumo: string): Promise<void> {
    const now = d.clock().getTime();
    const last = lastAlertAt.get(clienteId);
    if (last !== undefined && now - last < ALERT_INTERVAL_MS) return;
    lastAlertAt.set(clienteId, now);
    await d.alerts.create({ clienteId, motivo: 'Bot não conseguiu responder', resumo });
  }

  function showsLatestDraftTotal(clienteId: number, texto: string): boolean {
    const draft = latestOpenDraft(d.db, clienteId);
    return draft !== null && texto.replace(/ /g, ' ').includes(formatBRL(draft.totalCentavos));
  }

  /** Envia ao cliente e grava como fala do bot; devolve se saiu. */
  async function deliver(clienteId: number, telefone: string, texto: string, isAgentReply: boolean, opcoes?: string[]): Promise<boolean> {
    const r = await d.outbox.send({ telefone, texto, ...(opcoes ? { opcoes } : {}) });
    if (!r.ok) {
      console.error('agente: falha ao enviar resposta', clienteId, r.motivo, r.detalhe ?? '');
      return false;
    }
    const now = d.clock();
    // As opções entram no histórico: é assim que o modelo entende um "2" ou o título que o cliente tocou.
    const gravado = opcoes ? `${texto}\n\nOpções: ${opcoes.join(' · ')}` : texto;
    insertMessage(d.db, { clienteId, autor: 'bot', tipo: 'texto', texto: gravado, wamid: r.wamid, criadoEm: now.toISOString() });
    // Só depois de a resposta sair o cliente viu o resumo; sem isso nenhum rascunho pode ser confirmado.
    // E só conta como visto se a resposta repetiu o total do resumo mais recente.
    if (isAgentReply && showsLatestDraftTotal(clienteId, texto)) markDraftsPresented(d.db, clienteId, now);
    return true;
  }

  return async (clienteId: number): Promise<void> => {
    // O dono pode ter pausado o bot durante o debounce.
    if (paused(clienteId)) return;
    if (historyFor(d.db, clienteId, d.clock()).length === 0) return;

    let reply: AgentReply | null = null;
    try {
      reply = await d.agent.reply(clienteId);
    } catch (err) {
      console.error('agente: erro ao gerar resposta', clienteId, describeError(err));
    }
    // Pausado enquanto a IA pensava: o dono assumiu, então a resposta é descartada.
    if (paused(clienteId)) return;
    const telefone = getCustomer(d.db, clienteId)!.telefone;

    if (reply !== null) {
      if (await deliver(clienteId, telefone, reply.texto, true, reply.opcoes)) return;
      await alertOnce(clienteId, 'A resposta do bot não pôde ser enviada ao cliente.');
      return;
    }
    await deliver(clienteId, telefone, DESCULPA, false);
    await alertOnce(clienteId, 'O bot não conseguiu gerar uma resposta. Veja a conversa e responda pelo painel.');
  };
}
