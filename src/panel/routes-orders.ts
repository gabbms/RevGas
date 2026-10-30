import type { FastifyInstance } from 'fastify';
import { localDateKey, nextOpening } from '../domain/hours.js';
import { formatBRL } from '../domain/money.js';
import { samePhone } from '../domain/phone.js';
import type { OrderStatus } from '../domain/types.js';
import { formatAddress } from '../orders/dispatcher.js';
import { InvalidTransitionError } from '../orders/service.js';
import { getCustomer, listCustomers } from '../store/customers.js';
import { lastMessages } from '../store/messages.js';
import { getOrder, listOpenOrders, listOrdersByLocalDay, type Order } from '../store/orders.js';
import { renderPage, type PanelDeps } from './auth.js';
import { ago, formatPhone, minutesSince, quando } from './format.js';
import { ICONS } from './icons.js';
import { PAYMENT_LABEL, STATUS_LABEL } from './labels.js';

// Na tela, quem saiu está "Na rua" (no WhatsApp continua "Saiu").
const STATUS_ROTULO_PAINEL: Record<OrderStatus, string> = { ...STATUS_LABEL, saiu: 'Na rua' };

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
    if (o.status === 'recebido') acoes.push({ status: 'saiu', rotulo: 'Saiu' });
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
    const agora = deps.clock();
    const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: s.fuso, hour: '2-digit', minute: '2-digit' });
    const hoje = localDateKey(agora, s.fuso);
    // Pedidos criados hoje + os ainda em aberto de dias anteriores (um agendado de ontem à noite, um que saiu e não voltou).
    const porId = new Map<number, Order>();
    for (const o of listOrdersByLocalDay(deps.db, hoje, s.fuso)) porId.set(o.id, o);
    for (const o of listOpenOrders(deps.db)) porId.set(o.id, o);
    const abertura = nextOpening(s, agora);
    return [...porId.values()]
      .filter((o) => filtro === null || o.status === filtro)
      .sort((a, b) => b.id - a.id)
      .map((o) => {
        const cliente = getCustomer(deps.db, o.clienteId);
        const entregador = o.entregadorTelefone
          ? s.entregadores.find((e) => samePhone(e.telefone, o.entregadorTelefone!))?.nome
          : undefined;
        const selos: { texto: string; tom: 'warn' | 'neg' | 'neutral' }[] = [];
        if (o.pagamento === 'pix_antecipado') selos.push({ texto: 'Pix conferir', tom: 'warn' });
        if (o.pagamento === 'gas_do_povo') selos.push({ texto: 'Gás do Povo', tom: 'neutral' });
        if (o.precisaRevisao) selos.push({ texto: 'Revisar', tom: 'neg' });
        const criado = new Date(o.criadoEm);
        const aberto = o.status === 'recebido' || o.status === 'saiu';
        // Relógio da entrega: minutos desde o pedido contra a previsão prometida ao cliente.
        const decorridos = minutesSince(criado, agora);
        const promessa = s.previsaoEntregaMin;
        const relogio = aberto
          ? {
              decorridos,
              promessa,
              atrasado: decorridos > promessa,
              fracao: Math.min(1, decorridos / promessa),
              texto: decorridos > promessa ? `${decorridos - promessa} min além dos ${promessa}` : `${decorridos} de ${promessa} min`,
            }
          : null;
        return {
          id: o.id,
          clienteId: o.clienteId,
          cliente: cliente?.nome?.trim() || (cliente ? formatPhone(cliente.telefone) : `Cliente ${o.clienteId}`),
          hora: hora.format(criado),
          criadoHoje: localDateKey(criado, s.fuso) === hoje,
          fim: o.finalizadoEm ? hora.format(new Date(o.finalizadoEm)) : null,
          quantidade: o.quantidade,
          resumo: `${o.quantidade} × P13 ${o.modo === 'troca' ? 'troca' : 'completo'}`,
          tipo: o.tipo,
          endereco: o.endereco ? formatAddress(o.endereco) : null,
          pagamento: PAYMENT_LABEL[o.pagamento],
          troco: o.pagamento === 'dinheiro' && o.trocoParaCentavos ? formatBRL(o.trocoParaCentavos) : null,
          totalCentavos: o.totalCentavos,
          total: formatBRL(o.totalCentavos),
          status: o.status,
          statusRotulo: STATUS_ROTULO_PAINEL[o.status] + (o.status === 'saiu' && entregador ? ` · ${entregador}` : ''),
          aberto,
          agendadoPara: o.status === 'agendado' && abertura ? quando(abertura, agora, s.fuso) : null,
          relogio,
          selos,
          acoes: acoesDe(o),
        };
      });
  }

  type Linha = ReturnType<typeof linhas>[number];

  /** Tudo o que a lista mostra, calculado das próprias linhas (os números batem com o que está na tela). */
  function quadro(filtro: OrderStatus | null) {
    const s = deps.settings();
    const todas = linhas(filtro);
    const abertas = todas.filter((l) => l.aberto || l.status === 'agendado');
    const concluidas = todas.filter((l) => !l.aberto && l.status !== 'agendado');
    const esperando = todas.filter((l) => l.status === 'recebido');
    const naRua = todas.filter((l) => l.status === 'saiu');
    const vendidasHoje = todas.filter((l) => l.criadoHoje && l.status !== 'cancelado');
    const maisAntigo = esperando.reduce<Linha | null>((a, l) => (a === null || l.id < a.id ? l : a), null);
    const atrasados = todas.filter((l) => l.relogio?.atrasado).length;
    let achado: string;
    if (maisAntigo) {
      achado =
        `${esperando.length} ${esperando.length === 1 ? 'pedido esperando' : 'pedidos esperando'} sair · ` +
        `o mais antigo é de ${maisAntigo.cliente}, há ${maisAntigo.relogio!.decorridos} min`;
      if (atrasados > 0) achado += ` · ${atrasados} além dos ${s.previsaoEntregaMin} min prometidos`;
    } else if (naRua.length > 0) {
      achado = `Nenhum pedido esperando · ${naRua.length} na rua`;
    } else {
      achado = 'Nenhum pedido em aberto agora.';
    }
    const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: s.fuso, hour: '2-digit', minute: '2-digit' });
    return {
      abertas,
      concluidas,
      achado,
      atrasados,
      atualizado: hora.format(deps.clock()),
      kpis: {
        esperando: esperando.length,
        naRua: naRua.length,
        concluidos: concluidas.filter((l) => l.status === 'entregue' || l.status === 'retirado').length,
        botijoes: vendidasHoje.reduce((n, l) => n + l.quantidade, 0),
        vendido: formatBRL(vendidasHoje.reduce((n, l) => n + l.totalCentavos, 0)),
      },
    };
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
      ...quadro(filtro),
      filtro: filtro ?? '',
      erro: typeof erro === 'string' && Object.hasOwn(ERROS, erro) ? ERROS[erro] : null,
    });
  });

  // Fragmento que o htmx troca a cada 10 s.
  scope.get('/painel/pedidos/lista', async (req, reply) => {
    return reply.type('text/html; charset=utf-8').view('_lista.eta', { ...quadro(filtroDe(req.query)), icons: ICONS });
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
    const agora = deps.clock();
    const fmt = new Intl.DateTimeFormat('pt-BR', {
      timeZone: deps.settings().fuso,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const alertas = deps.alerts.listOpen().map((a) => {
      const c = a.clienteId !== null ? getCustomer(deps.db, a.clienteId) : null;
      const criado = new Date(a.criadoEm);
      return {
        id: a.id,
        motivo: a.motivo,
        resumo: a.resumo,
        clienteId: c && !c.telefone.startsWith('excluido-') ? c.id : null,
        cliente: c ? c.nome?.trim() || formatPhone(c.telefone) : null,
        pedidoId: a.pedidoId,
        quando: fmt.format(criado),
        ha: ago(criado, agora),
      };
    });
    // listOpen vem do mais novo para o mais antigo: o último é o que espera há mais tempo.
    const maisAntigo = alertas.at(-1);
    const achado = maisAntigo
      ? `${alertas.length} ${alertas.length === 1 ? 'alerta aberto' : 'alertas abertos'} · o mais antigo ${maisAntigo.ha}`
      : 'Nenhum alerta aberto. O bot avisa aqui quando precisar de você.';
    // Conversas que o dono assumiu (bot pausado): quase sempre o passo seguinte a um alerta.
    const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: deps.settings().fuso, hour: '2-digit', minute: '2-digit' });
    const ultimas = lastMessages(deps.db);
    const assumidas = listCustomers(deps.db)
      .filter((c) => !c.telefone.startsWith('excluido-') && c.botPausadoAte !== null && new Date(c.botPausadoAte) > agora)
      .sort((a, b) => a.botPausadoAte!.localeCompare(b.botPausadoAte!))
      .map((c) => {
        const m = ultimas.get(c.id);
        return {
          id: c.id,
          nome: c.nome?.trim() || formatPhone(c.telefone),
          ate: hora.format(new Date(c.botPausadoAte!)),
          esperandoVoce: m?.autor === 'cliente',
          previa: m ? (m.autor === 'cliente' ? '' : m.autor === 'dono' ? 'Você: ' : 'Bot: ') + m.texto : '',
        };
      });
    return renderPage(deps, reply, 'alertas.eta', 'alertas', { titulo: 'Alertas', alertas, achado, assumidas });
  });

  scope.post('/painel/alertas/:id/resolver', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (Number.isInteger(id)) deps.alerts.resolve(id);
    return reply.redirect('/painel/alertas');
  });
}
