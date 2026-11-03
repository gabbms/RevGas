import type { FastifyInstance } from 'fastify';
import { localDateKey, nextOpening } from '../domain/hours.js';
import { formatBRL } from '../domain/money.js';
import { samePhone } from '../domain/phone.js';
import type { OrderStatus } from '../domain/types.js';
import { formatAddress } from '../orders/dispatcher.js';
import { InvalidTransitionError } from '../orders/service.js';
import { getCustomer, listCustomers } from '../store/customers.js';
import { lastMessages, recentMessages } from '../store/messages.js';
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

// A ação principal do cartão: o próximo passo natural do pedido. O painel lateral mostra todas.
function principalDe(o: Order): { status: 'saiu' | 'entregue' | 'retirado'; rotulo: string; icone: 'moto' | 'check' } | null {
  if (o.status === 'recebido') {
    return o.tipo === 'entrega' ? { status: 'saiu', rotulo: 'Saiu para entrega', icone: 'moto' } : { status: 'retirado', rotulo: 'Retirado', icone: 'check' };
  }
  if (o.status === 'saiu') return { status: 'entregue', rotulo: 'Confirmar entrega', icone: 'check' };
  return null;
}

const PAGAMENTO_ICONE = {
  dinheiro: 'dinheiro',
  cartao: 'cartao',
  pix_entrega: 'pix',
  pix_antecipado: 'pix',
  gas_do_povo: 'chama',
} as const;

const iniciais = (nome: string): string =>
  nome
    .split(/\s+/)
    .filter((p) => /^\p{L}/u.test(p))
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

const isStatus = (s: unknown): s is OrderStatus => typeof s === 'string' && Object.hasOwn(STATUS_LABEL, s);

export function registerOrderRoutes(scope: FastifyInstance, deps: PanelDeps): void {
  const duracao = (min: number): string => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`);

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
        const agendadoPara = o.status === 'agendado' && abertura ? quando(abertura, agora, s.fuso) : null;
        const fim = o.finalizadoEm ? hora.format(new Date(o.finalizadoEm)) : null;
        return {
          id: o.id,
          clienteId: o.clienteId,
          cliente: cliente?.nome?.trim() || (cliente ? formatPhone(cliente.telefone) : `Cliente ${o.clienteId}`),
          hora: hora.format(criado),
          criadoHoje: localDateKey(criado, s.fuso) === hoje,
          fim,
          quantidade: o.quantidade,
          resumo: `${o.quantidade} × P13 ${o.modo === 'troca' ? 'troca' : 'completo'}`,
          tipo: o.tipo,
          endereco: o.endereco ? formatAddress(o.endereco) : null,
          pagamento: PAYMENT_LABEL[o.pagamento],
          pagIcone: PAGAMENTO_ICONE[o.pagamento],
          troco: o.pagamento === 'dinheiro' && o.trocoParaCentavos ? formatBRL(o.trocoParaCentavos) : null,
          totalCentavos: o.totalCentavos,
          total: formatBRL(o.totalCentavos),
          status: o.status,
          statusRotulo: STATUS_ROTULO_PAINEL[o.status] + (o.status === 'saiu' && entregador ? ` · ${entregador}` : ''),
          aberto,
          agendadoPara,
          // O que o cartão mostra no canto: tempo de espera, quando sai (agendado) ou a que horas terminou.
          tempo: aberto ? duracao(decorridos) : agendadoPara ? agendadoPara : (fim ?? ''),
          atrasado: relogio?.atrasado ?? false,
          entregador: entregador ?? null,
          iniciais: entregador ? iniciais(entregador) : '',
          relogio,
          selos,
          acoes: acoesDe(o),
          principal: principalDe(o),
        };
      });
  }

  type Linha = ReturnType<typeof linhas>[number];

  /** O quadro: colunas e o resumo, calculados das próprias linhas (os números batem com o que está na tela). */
  function quadro(filtro: OrderStatus | null, selecionadoId: number | null = null) {
    const s = deps.settings();
    const todas = linhas(filtro);
    const maisAntigosPrimeiro = (a: Linha, b: Linha) => a.id - b.id;
    const agendados = todas.filter((l) => l.status === 'agendado').sort(maisAntigosPrimeiro);
    const esperando = todas.filter((l) => l.status === 'recebido').sort(maisAntigosPrimeiro);
    const naRua = todas.filter((l) => l.status === 'saiu').sort(maisAntigosPrimeiro);
    const concluidos = todas.filter((l) => !l.aberto && l.status !== 'agendado');
    const maisAntigo = esperando[0] ?? null;
    const atrasados = todas.filter((l) => l.atrasado).length;
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
    const colunas = [
      { id: 'agendados', rotulo: 'Agendados', dica: 'saem quando a loja abrir', cor: 'var(--color-neutral-500)', cartoes: agendados, vazio: 'Nenhum pedido agendado' },
      { id: 'esperando', rotulo: 'Esperando sair', dica: 'mais antigos primeiro', cor: 'var(--color-accent)', cartoes: esperando, vazio: 'Nenhum pedido esperando' },
      { id: 'na-rua', rotulo: 'Na rua', dica: '', cor: 'var(--flame)', cartoes: naRua, vazio: 'Nada na rua agora' },
      { id: 'concluidos', rotulo: 'Concluídos hoje', dica: '', cor: 'var(--c-ok)', cartoes: concluidos, vazio: 'Nenhum pedido concluído hoje ainda' },
    ];
    return { colunas, achado, atrasados, atualizado: hora.format(deps.clock()), selecionadoId };
  }

  /** O painel lateral de um pedido: tudo vem do pedido, do cliente e das últimas mensagens da conversa. */
  function detalhe(id: number) {
    const o = getOrder(deps.db, id);
    if (!o) return null;
    const s = deps.settings();
    const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: s.fuso, hour: '2-digit', minute: '2-digit' });
    const cliente = getCustomer(deps.db, o.clienteId);
    const excluido = !cliente || cliente.telefone.startsWith('excluido-');
    const entregador = o.entregadorTelefone
      ? s.entregadores.find((e) => samePhone(e.telefone, o.entregadorTelefone!))?.nome ?? null
      : null;
    const retirada = o.tipo === 'retirada';
    const cancelado = o.status === 'cancelado';
    const marcos: { rotulo: string; em: string | null }[] = [
      { rotulo: 'Recebido', em: o.criadoEm },
      { rotulo: 'Enviado', em: o.enviadoEm },
      ...(retirada ? [] : [{ rotulo: 'Na rua', em: o.saiuEm }]),
      { rotulo: cancelado ? 'Cancelado' : retirada ? 'Retirado' : 'Entregue', em: o.finalizadoEm },
    ];
    const etapas = marcos.map((m) => ({ rotulo: m.rotulo, hora: m.em ? hora.format(new Date(m.em)) : '—', feita: m.em !== null }));
    const q = o.quantidade;
    const itens: { rotulo: string; valor: string }[] = [];
    if (o.pagamento === 'gas_do_povo') {
      itens.push({ rotulo: `${q}× P13 ${o.modo === 'troca' ? 'troca' : 'completo'}`, valor: 'Gás do Povo' });
    } else {
      itens.push({ rotulo: `${q}× P13 ${o.modo === 'troca' ? 'troca' : 'completo'}`, valor: formatBRL(q * o.unitarioCentavos) });
    }
    if (o.cascoCentavos > 0) itens.push({ rotulo: `${q}× casco`, valor: formatBRL(q * o.cascoCentavos) });
    if (o.taxaEntregaCentavos > 0) itens.push({ rotulo: 'Taxa de entrega', valor: formatBRL(o.taxaEntregaCentavos) });
    const avisos: string[] = [];
    if (o.pagamento === 'pix_antecipado') avisos.push('Pix antecipado: confira o comprovante antes de entregar.');
    if (o.precisaRevisao) avisos.push(`Pedido com ${q} botijões: confira antes de entregar.`);
    const mensagens = excluido
      ? []
      : recentMessages(deps.db, o.clienteId, new Date(0), 8)
          .filter((m) => m.tipo !== 'sistema')
          .map((m) => ({ de: m.autor, texto: m.texto, hora: hora.format(new Date(m.criadoEm)) }));
    const linha = linhas(null).find((l) => l.id === id);
    const endereco = o.endereco ? formatAddress(o.endereco) : null;
    return {
      id: o.id,
      clienteId: o.clienteId,
      cliente: cliente?.nome?.trim() || (cliente && !excluido ? formatPhone(cliente.telefone) : `Cliente ${o.clienteId}`),
      telefone: cliente && !excluido ? formatPhone(cliente.telefone) : null,
      temConversa: !excluido,
      retirada,
      endereco,
      mapa: endereco ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(endereco)}` : null,
      status: o.status,
      statusRotulo: STATUS_ROTULO_PAINEL[o.status],
      etapas,
      itens,
      total: formatBRL(o.totalCentavos),
      pagamento: PAYMENT_LABEL[o.pagamento],
      pagIcone: PAGAMENTO_ICONE[o.pagamento],
      troco: o.pagamento === 'dinheiro' ? (o.trocoParaCentavos ? `Troco para ${formatBRL(o.trocoParaCentavos)}` : 'Sem troco') : null,
      avisos,
      entregador,
      iniciais: entregador ? iniciais(entregador) : '',
      esperaEntregador: o.status === 'recebido' && !retirada,
      mensagens,
      acoes: acoesDe(o),
      concluido: ['entregue', 'retirado', 'cancelado'].includes(o.status),
      fim: linha?.fim ?? null,
      abertoHa: linha?.aberto ? duracao(linha.relogio!.decorridos) : null,
    };
  }

  const filtroDe = (q: unknown): OrderStatus | null => {
    const v = (q as { status?: unknown } | undefined)?.status;
    return isStatus(v) ? v : null;
  };
  const pedidoDe = (q: unknown): number | null => {
    const n = Number((q as { pedido?: unknown } | undefined)?.pedido);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  scope.get('/painel/pedidos', async (req, reply) => {
    const filtro = filtroDe(req.query);
    const erro = (req.query as { erro?: unknown } | undefined)?.erro;
    const aberto = pedidoDe(req.query);
    const d = aberto === null ? null : detalhe(aberto);
    return renderPage(deps, reply, 'pedidos.eta', 'pedidos', {
      titulo: 'Pedidos de hoje',
      ...quadro(filtro, d?.id ?? null),
      icons: ICONS,
      detalhe: d,
      filtro: filtro ?? '',
      erro: typeof erro === 'string' && Object.hasOwn(ERROS, erro) ? ERROS[erro] : null,
    });
  });

  // Fragmentos que o htmx troca a cada 10 s: o quadro e o painel lateral do pedido aberto.
  scope.get('/painel/pedidos/lista', async (req, reply) => {
    const aberto = pedidoDe(req.query);
    return reply
      .type('text/html; charset=utf-8')
      .view('_lista.eta', { ...quadro(filtroDe(req.query), aberto), icons: ICONS });
  });

  scope.get('/painel/pedidos/:id/detalhe', async (req, reply) => {
    const d = detalhe(Number((req.params as { id: string }).id));
    if (!d) return reply.code(404).type('text/html; charset=utf-8').send('');
    return reply.type('text/html; charset=utf-8').view('_detalhe.eta', { detalhe: d, icons: ICONS });
  });

  scope.post('/painel/pedidos/:id/status', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const corpo = req.body as { status?: unknown; de?: unknown } | undefined;
    const status = corpo?.status;
    // Quem agiu pelo painel lateral volta a ele; só esse valor é aceito.
    const base = corpo?.de === 'detalhe' && Number.isInteger(id) ? `/painel/pedidos?pedido=${id}` : '/painel/pedidos';
    const voltar = (erro?: string) => reply.redirect(erro ? `${base}${base.includes('?') ? '&' : '?'}erro=${erro}` : base);

    if (!Number.isInteger(id) || !getOrder(deps.db, id)) return reply.redirect('/painel/pedidos?erro=inexistente');
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
