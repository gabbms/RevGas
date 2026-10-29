import type { FastifyInstance } from 'fastify';
import { localDateKey } from '../domain/hours.js';
import { formatBRL } from '../domain/money.js';
import { samePhone } from '../domain/phone.js';
import type { OrderStatus } from '../domain/types.js';
import { formatAddress } from '../orders/dispatcher.js';
import { InvalidTransitionError } from '../orders/service.js';
import { getCustomer } from '../store/customers.js';
import { getOrder, listOrdersByLocalDay, type Order } from '../store/orders.js';
import { renderPage, type PanelDeps } from './auth.js';
import { PAYMENT_LABEL, STATUS_LABEL } from './labels.js';

// O redirect leva só um código; o texto vem daqui (nada digitado pelo usuário volta para a página).
const ERROS: Record<string, string> = {
  transicao: 'Não foi possível mudar o pedido: ele não está nesse estado. A lista foi atualizada.',
  finalizado: 'Não foi possível cancelar: o pedido já foi finalizado.',
  inexistente: 'Pedido não encontrado.',
  invalido: 'Ação inválida.',
};

type Acao = { status: 'saiu' | 'entregue' | 'retirado' | 'cancelado'; rotulo: string; perigo?: boolean };

function acoesDe(o: Order): Acao[] {
  const acoes: Acao[] = [];
  if (o.tipo === 'entrega') {
    if (o.status === 'recebido') acoes.push({ status: 'saiu', rotulo: 'Saiu para entrega' });
    if (o.status === 'recebido' || o.status === 'saiu') acoes.push({ status: 'entregue', rotulo: 'Entregue' });
  } else if (o.status === 'recebido') {
    acoes.push({ status: 'retirado', rotulo: 'Retirado' });
  }
  if (o.status === 'agendado' || o.status === 'recebido' || o.status === 'saiu') {
    acoes.push({ status: 'cancelado', rotulo: 'Cancelar', perigo: true });
  }
  return acoes;
}

const isStatus = (s: unknown): s is OrderStatus => typeof s === 'string' && Object.hasOwn(STATUS_LABEL, s);

export function registerOrderRoutes(scope: FastifyInstance, deps: PanelDeps): void {
  function linhas(filtro: OrderStatus | null) {
    const s = deps.settings();
    const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: s.fuso, hour: '2-digit', minute: '2-digit' });
    return listOrdersByLocalDay(deps.db, localDateKey(deps.clock(), s.fuso), s.fuso)
      .filter((o) => filtro === null || o.status === filtro)
      .sort((a, b) => b.id - a.id)
      .map((o) => {
        const cliente = getCustomer(deps.db, o.clienteId);
        const entregador = o.entregadorTelefone
          ? s.entregadores.find((e) => samePhone(e.telefone, o.entregadorTelefone!))?.nome
          : undefined;
        const selos: string[] = [];
        if (o.pagamento === 'pix_antecipado') selos.push('Pix conferir');
        if (o.pagamento === 'gas_do_povo') selos.push('Gás do Povo');
        if (o.precisaRevisao) selos.push('Revisar');
        return {
          id: o.id,
          clienteId: o.clienteId,
          cliente: cliente?.nome?.trim() || cliente?.telefone || `Cliente ${o.clienteId}`,
          hora: hora.format(new Date(o.criadoEm)),
          resumo: `${o.quantidade} × P13 (${o.modo === 'troca' ? 'troca' : 'completo'})`,
          tipo: o.tipo === 'entrega' ? 'Entrega' : 'Retirada',
          endereco: o.endereco ? formatAddress(o.endereco) : null,
          pagamento: PAYMENT_LABEL[o.pagamento],
          troco: o.pagamento === 'dinheiro' && o.trocoParaCentavos ? formatBRL(o.trocoParaCentavos) : null,
          total: formatBRL(o.totalCentavos),
          status: o.status,
          statusRotulo: STATUS_LABEL[o.status] + (o.status === 'saiu' && entregador ? ` · ${entregador}` : ''),
          selos,
          acoes: acoesDe(o),
        };
      });
  }

  const filtroDe = (q: unknown): OrderStatus | null => {
    const v = (q as { status?: unknown } | undefined)?.status;
    return isStatus(v) ? v : null;
  };

  scope.get('/painel', async (_req, reply) => reply.redirect('/painel/pedidos'));

  scope.get('/painel/pedidos', async (req, reply) => {
    const filtro = filtroDe(req.query);
    const erro = (req.query as { erro?: unknown } | undefined)?.erro;
    return renderPage(deps, reply, 'pedidos.eta', 'pedidos', {
      titulo: 'Pedidos de hoje',
      pedidos: linhas(filtro),
      filtro: filtro ?? '',
      filtros: Object.entries(STATUS_LABEL).map(([id, rotulo]) => ({ id, rotulo })),
      erro: typeof erro === 'string' && Object.hasOwn(ERROS, erro) ? ERROS[erro] : null,
    });
  });

  // Fragmento que o htmx troca a cada 10 s.
  scope.get('/painel/pedidos/lista', async (req, reply) => {
    return reply.type('text/html; charset=utf-8').view('_lista.eta', { pedidos: linhas(filtroDe(req.query)) });
  });

  scope.post('/painel/pedidos/:id/status', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const status = (req.body as { status?: unknown } | undefined)?.status;
    const voltar = (erro?: string) => reply.redirect(erro ? `/painel/pedidos?erro=${erro}` : '/painel/pedidos');

    if (!Number.isInteger(id) || !getOrder(deps.db, id)) return voltar('inexistente');
    try {
      if (status === 'cancelado') {
        const r = await deps.orders.cancel(id, 'dono');
        return voltar(r.ok ? undefined : 'finalizado');
      }
      if (status === 'saiu' || status === 'entregue' || status === 'retirado') {
        await deps.orders.setStatus(id, status);
        return voltar();
      }
      return voltar('invalido');
    } catch (err) {
      if (err instanceof InvalidTransitionError) return voltar('transicao');
      throw err;
    }
  });

  scope.get('/painel/alertas', async (_req, reply) => {
    const fmt = new Intl.DateTimeFormat('pt-BR', {
      timeZone: deps.settings().fuso,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const alertas = deps.alerts.listOpen().map((a) => ({
      id: a.id,
      motivo: a.motivo,
      resumo: a.resumo,
      clienteId: a.clienteId,
      quando: fmt.format(new Date(a.criadoEm)),
    }));
    return renderPage(deps, reply, 'alertas.eta', 'alertas', { titulo: 'Alertas', alertas });
  });

  scope.post('/painel/alertas/:id/resolver', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (Number.isInteger(id)) deps.alerts.resolve(id);
    return reply.redirect('/painel/alertas');
  });
}
