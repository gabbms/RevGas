import type { AlertService } from '../alerts/service.js';
import type { Db } from '../db/connection.js';
import { formatHorarios, isOpen, nextOpening } from '../domain/hours.js';
import { formatBRL } from '../domain/money.js';
import { validateOrderRequest, type OrderRequest } from '../domain/order-validation.js';
import type { Quote } from '../domain/pricing.js';
import type { Address, CylinderMode, OrderKind, OrderStatus, PaymentMethod } from '../domain/types.js';
import { formatAddress } from '../orders/dispatcher.js';
import type { OrderService } from '../orders/service.js';
import { getCustomer, updateCustomer, type Customer } from '../store/customers.js';
import {
  consumeDraft,
  createDraft,
  getDraft,
  RECENT_DRAFT_WINDOW_MS,
  supersedeOpenDrafts,
  type DraftConditions,
} from '../store/drafts.js';
import { getOrder, lastOrderFor, type Order } from '../store/orders.js';
import { moveReceiptsToDraft } from '../store/receipts.js';
import type { StoreSettings } from '../store/settings.js';

export interface ToolContext {
  db: Db;
  clienteId: number;
  settings: () => StoreSettings;
  orders: OrderService;
  alerts: AlertService;
  clock: () => Date;
  /** Quando chegou a última mensagem do cliente: um rascunho feito depois dela ainda não foi visto por ele. */
  ultimaMensagemClienteEm: Date;
}

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  dinheiro: 'Dinheiro',
  cartao: 'Cartão (maquininha)',
  pix_entrega: 'Pix na entrega',
  pix_antecipado: 'Pix antecipado',
  gas_do_povo: 'Gás do Povo',
};

const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;
const ERRO_MESMO_TURNO = 'mostre o resumo e espere o cliente confirmar';
const ERRO_NAO_ENCONTRADO = 'pedido não encontrado';

/** Rascunhos com confirmação em andamento neste processo (evita dois pedidos com "sim" repetido em paralelo). */
const confirmando = new Set<number>();

/** Data e hora local da loja, no formato 'seg 02/11 10:00'. */
export function formatLocalDateTime(d: Date, fuso: string): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: fuso,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? '';
  const dia = get('weekday').replace('.', '').toLowerCase();
  return `${dia} ${get('day')}/${get('month')} ${get('hour')}:${get('minute')}`;
}

const priceOrMissing = (cents: number): string => (cents > 0 ? formatBRL(cents) : 'não cadastrado');

function nextOpeningLabel(s: StoreSettings, now: Date): string | undefined {
  const n = nextOpening(s, now);
  return n ? formatLocalDateTime(n, s.fuso) : undefined;
}

interface SummaryInput {
  tipo: OrderKind;
  quantidade: number;
  modo: CylinderMode;
  pagamento: PaymentMethod;
  trocoParaCentavos?: number | null;
  endereco?: Address | null;
  quote: Quote;
  agendadoPara?: string;
}

function buildSummary(s: StoreSettings, i: SummaryInput): string[] {
  const q = i.quantidade;
  const botijoes = `${q} ${q === 1 ? 'botijão' : 'botijões'} P13`;
  const lines: string[] = [];
  if (i.pagamento === 'gas_do_povo') {
    lines.push(`${botijoes} – recarga pelo Gás do Povo${i.modo === 'completo' ? ' (sem vazio para trocar)' : ' (troca do vazio)'}`);
  } else {
    const modo = i.modo === 'troca' ? 'troca (com o vazio)' : 'completo (botijão novo com gás)';
    lines.push(`${botijoes} – ${modo} – ${formatBRL(i.quote.unitarioCentavos)} cada`);
  }
  if (i.quote.cascoCentavos > 0) lines.push(`Casco: ${formatBRL(i.quote.cascoCentavos)} cada`);
  if (i.quote.taxaEntregaCentavos > 0) lines.push(`Taxa de entrega: ${formatBRL(i.quote.taxaEntregaCentavos)}`);
  lines.push(`Total: ${formatBRL(i.quote.totalCentavos)}`);
  if (i.tipo === 'retirada') {
    lines.push(s.enderecoLoja.trim() ? `Retirada na loja: ${s.enderecoLoja.trim()}` : 'Retirada na loja');
  } else if (i.endereco) {
    lines.push(`Endereço: ${formatAddress(i.endereco)}`);
  }
  lines.push(`Pagamento: ${PAYMENT_LABELS[i.pagamento]}`);
  if (i.pagamento === 'dinheiro') {
    lines.push(i.trocoParaCentavos != null ? `Troco para ${formatBRL(i.trocoParaCentavos)}` : 'Sem troco');
  }
  if (i.pagamento === 'pix_antecipado' && s.chavePix) lines.push(`Chave Pix: ${s.chavePix}`);
  if (i.agendadoPara) lines.push(`Agendado para quando a loja abrir (${i.agendadoPara})`);
  return lines;
}

const orderQuote = (o: Order): Quote => ({
  unitarioCentavos: o.unitarioCentavos,
  cascoCentavos: o.cascoCentavos,
  taxaEntregaCentavos: o.taxaEntregaCentavos,
  totalCentavos: o.totalCentavos,
});

/** O que o resumo mostrou e que, se mudar, exige um resumo novo. */
function draftConditions(s: StoreSettings, req: OrderRequest, agendado: boolean): DraftConditions {
  return { agendado, chavePix: req.pagamento === 'pix_antecipado' ? (s.chavePix ?? null) : null };
}

/** Previsão de entrega só vale para entrega já liberada à equipe (não para retirada nem agendado). */
function deliveryEstimate(s: StoreSettings, o: Order): { previsaoEntregaMin?: number } {
  return o.tipo === 'entrega' && o.status !== 'agendado' ? { previsaoEntregaMin: s.previsaoEntregaMin } : {};
}

export type PrepararResult =
  | {
      rascunhoId: number;
      tipo: OrderKind;
      agendado: boolean;
      proximaAbertura?: string;
      resumo: string[];
      total: string;
    }
  | { erros: string[] };

export type ConfirmarResult =
  | { numero: number; status: OrderStatus; tipo: OrderKind; previsaoEntregaMin?: number; agendado: boolean; proximaAbertura?: string }
  | { erro: 'preco_mudou' | 'condicoes_mudaram'; novoRascunho: PrepararResult }
  | { erro: string }
  | { erros: string[] };

export type AlterarResult =
  | { ok: true; resumo: string[] }
  | { ok: false; erros: string[] }
  | { ok: false; motivo: 'ja_saiu' | 'finalizado' }
  | { ok: false; erro: string };

export type CancelarResult = { ok: true } | { ok: false; motivo: 'ja_saiu' | 'finalizado' } | { ok: false; erro: string };

export function createToolHandlers(ctx: ToolContext) {
  const { db, clienteId } = ctx;

  function customer(): Customer {
    const c = getCustomer(db, clienteId);
    if (!c) throw new Error(`cliente ${clienteId} não existe`);
    return c;
  }

  /** O pedido só existe para a IA se for deste cliente. */
  function ownOrder(numero: number): Order | null {
    const o = getOrder(db, numero);
    return o && o.clienteId === clienteId ? o : null;
  }

  async function consultarLoja() {
    const s = ctx.settings();
    const now = ctx.clock();
    const abertaAgora = isOpen(s, now);
    const proximaAbertura = abertaAgora ? undefined : nextOpeningLabel(s, now);
    // Mesmo critério da validação do pedido: Pix antecipado só com chave cadastrada.
    const aceitaPix = s.pagamentos.includes('pix_antecipado') && !!s.chavePix;
    return {
      nomeLoja: s.nomeLoja,
      enderecoLoja: s.enderecoLoja,
      agora: formatLocalDateTime(now, s.fuso),
      abertaAgora,
      horarios: formatHorarios(s),
      ...(proximaAbertura ? { proximaAbertura } : {}),
      precoRecarga: priceOrMissing(s.precoRecargaCentavos),
      precoCompleto: priceOrMissing(s.precoCompletoCentavos),
      previsaoEntregaMin: s.previsaoEntregaMin,
      bairros: s.bairros,
      // Gás do Povo só conta como aceito se estiver ligado nas duas configurações (igual à validação do pedido).
      pagamentos: s.pagamentos
        .filter((p) => p !== 'gas_do_povo' || s.gasDoPovo.aceita)
        .filter((p) => p !== 'pix_antecipado' || aceitaPix)
        .map((p) => PAYMENT_LABELS[p]),
      ...(aceitaPix ? { chavePix: s.chavePix! } : {}),
      gasDoPovo: {
        aceita: s.gasDoPovo.aceita && s.pagamentos.includes('gas_do_povo'),
        modalidade: s.gasDoPovo.modalidade,
        taxaEntrega: formatBRL(s.gasDoPovo.taxaEntregaCentavos),
      },
    };
  }

  async function consultarCliente() {
    const s = ctx.settings();
    const c = customer();
    const ultimo = lastOrderFor(db, clienteId);
    return {
      nome: c.nome,
      endereco: c.endereco,
      jaPediuAntes: ultimo !== null,
      ...(ultimo
        ? {
            ultimoPedido: {
              quantidade: ultimo.quantidade,
              modo: ultimo.modo,
              pagamento: ultimo.pagamento,
              ...(ultimo.trocoParaCentavos !== null ? { trocoPara: formatBRL(ultimo.trocoParaCentavos) } : {}),
            },
          }
        : {}),
      pedidosEmAberto: ctx.orders.openOrdersFor(clienteId).map((o) => ({
        numero: o.id,
        status: o.status,
        tipo: o.tipo,
        criadoEm: formatLocalDateTime(new Date(o.criadoEm), s.fuso),
        ...deliveryEstimate(s, o),
      })),
      lembretesDesativados: c.lembretesDesativados,
    };
  }

  async function salvarCliente(i: { nome?: string; endereco?: Address }): Promise<{ ok: true }> {
    updateCustomer(db, clienteId, {
      ...(i.nome !== undefined ? { nome: i.nome.trim() } : {}),
      ...(i.endereco !== undefined ? { endereco: i.endereco } : {}),
    });
    return { ok: true };
  }

  async function prepararPedido(req: OrderRequest): Promise<PrepararResult> {
    const s = ctx.settings();
    const now = ctx.clock();
    const saved = req.endereco ? undefined : customer().endereco;
    const full: OrderRequest = saved ? { ...req, endereco: saved } : req;
    const v = validateOrderRequest(s, full, now);
    if (!v.ok) return { erros: v.erros };

    // Só o resumo mais recente pode ser confirmado.
    supersedeOpenDrafts(db, clienteId, now);
    const draft = createDraft(db, clienteId, full, v.quote.totalCentavos, now, draftConditions(s, full, v.agendado));
    // Comprovante Pix mandado com o resumo anterior continua valendo para o resumo novo.
    if (full.pagamento === 'pix_antecipado') moveReceiptsToDraft(db, clienteId, draft.id, now, RECENT_DRAFT_WINDOW_MS);
    const proximaAbertura = v.agendado ? nextOpeningLabel(s, now) : undefined;
    return {
      rascunhoId: draft.id,
      tipo: v.tipo,
      agendado: v.agendado,
      ...(proximaAbertura ? { proximaAbertura } : {}),
      resumo: buildSummary(s, { ...full, tipo: v.tipo, quote: v.quote, agendadoPara: proximaAbertura }),
      total: formatBRL(v.quote.totalCentavos),
    };
  }

  async function confirmarPedido(i: { rascunhoId: number }): Promise<ConfirmarResult> {
    const now = ctx.clock();
    const d = getDraft(db, i.rascunhoId);
    if (!d || d.clienteId !== clienteId) return { erro: 'rascunho não encontrado; chame preparar_pedido de novo' };
    if (d.substituidoEm !== null) return { erro: 'esse resumo foi substituído; use o resumo mais recente' };
    if (d.consumidoEm !== null || confirmando.has(d.id)) return { erro: 'esse resumo já foi confirmado' };
    if (now.getTime() - new Date(d.criadoEm).getTime() > DRAFT_TTL_MS) {
      return { erro: 'esse resumo expirou; chame preparar_pedido de novo e mostre o novo resumo' };
    }
    // O cliente só pode ter dito "sim" a um resumo que já tinha chegado a ele antes da mensagem dele.
    if (d.apresentadoEm === null || new Date(d.apresentadoEm).getTime() >= ctx.ultimaMensagemClienteEm.getTime()) {
      return { erro: ERRO_MESMO_TURNO };
    }

    const s0 = ctx.settings();
    const v = validateOrderRequest(s0, d.request, now);
    if (v.ok && v.quote.totalCentavos !== d.totalCentavos) {
      return { erro: 'preco_mudou', novoRascunho: await prepararPedido(d.request) };
    }
    if (v.ok && d.condicoes) {
      const atual = draftConditions(s0, d.request, v.agendado);
      if (atual.agendado !== d.condicoes.agendado || atual.chavePix !== d.condicoes.chavePix) {
        return { erro: 'condicoes_mudaram', novoRascunho: await prepararPedido(d.request) };
      }
    }

    confirmando.add(d.id);
    try {
      const r = await ctx.orders.create(clienteId, d.request);
      if (!r.ok) return { erros: r.erros };
      consumeDraft(db, d.id, ctx.clock());
      const o = r.order;
      if (o.endereco && !customer().endereco) updateCustomer(db, clienteId, { endereco: o.endereco });

      const s = ctx.settings();
      const agendado = o.status === 'agendado';
      const proximaAbertura = agendado ? nextOpeningLabel(s, now) : undefined;
      return {
        numero: o.id,
        status: o.status,
        tipo: o.tipo,
        ...deliveryEstimate(s, o),
        agendado,
        ...(proximaAbertura ? { proximaAbertura } : {}),
      };
    } finally {
      confirmando.delete(d.id);
    }
  }

  async function alterarPedido(i: { numero: number; mudancas: Partial<OrderRequest> }): Promise<AlterarResult> {
    const before = ownOrder(i.numero);
    if (!before) return { ok: false, erro: ERRO_NAO_ENCONTRADO };
    // Retirada que vira entrega sem endereço novo: usa o endereço salvo, como no preparar_pedido.
    const saved = !i.mudancas.endereco && !before.endereco ? customer().endereco : null;
    const mudancas = saved ? { ...i.mudancas, endereco: saved } : i.mudancas;

    const r = await ctx.orders.change(i.numero, mudancas);
    if (r.ok) {
      const o = r.order;
      return { ok: true, resumo: buildSummary(ctx.settings(), { ...o, quote: orderQuote(o) }) };
    }
    if ('erros' in r) return { ok: false, erros: r.erros };
    return { ok: false, motivo: r.motivo };
  }

  async function cancelarPedido(i: { numero: number }): Promise<CancelarResult> {
    if (!ownOrder(i.numero)) return { ok: false, erro: ERRO_NAO_ENCONTRADO };
    return ctx.orders.cancel(i.numero, 'cliente');
  }

  async function alertarDono(i: { motivo: string; resumo: string }): Promise<{ ok: true }> {
    await ctx.alerts.create({ clienteId, motivo: i.motivo, resumo: i.resumo });
    return { ok: true };
  }

  async function desativarLembretes(): Promise<{ ok: true }> {
    updateCustomer(db, clienteId, { lembretesDesativados: true });
    return { ok: true };
  }

  return {
    consultarLoja,
    consultarCliente,
    salvarCliente,
    prepararPedido,
    confirmarPedido,
    alterarPedido,
    cancelarPedido,
    alertarDono,
    desativarLembretes,
  };
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
