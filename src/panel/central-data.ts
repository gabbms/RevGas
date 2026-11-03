import { localDateKey, localHour, todayHours } from '../domain/hours.js';
import { formatBRL } from '../domain/money.js';
import { samePhone } from '../domain/phone.js';
import { getCustomer, listCustomers } from '../store/customers.js';
import { lastMessages, lastMessageTimes, messagesSince } from '../store/messages.js';
import { listOpenOrders, listOrdersByLocalDay, type Order } from '../store/orders.js';
import type { PanelDeps } from './auth.js';
import { ago, formatPhone, minutesSince, storeStatus } from './format.js';

const MIN = 60_000;
const DIA = 24 * 60 * MIN;
const ATIVA_MS = 30 * MIN;
/** Faixa do gráfico quando a loja não abre hoje. */
const HORAS_PADRAO = { de: 7, ate: 19 };
const MAX_ATENCAO = 6;
const MAX_ATIVIDADE = 7;

type Item = {
  tom: 'alerta' | 'neutro';
  icone: 'atendente' | 'sino' | 'relogio';
  titulo: string;
  sub: string;
  tempo: string;
  acao: { rotulo: string; href: string };
};

const plural = (n: number, um: string, varios: string): string => `${n} ${n === 1 ? um : varios}`;

/** Conversas de hoje: quantas, quantas o dono precisou entrar e o tempo médio do bot para responder. */
function conversasDeHoje(deps: PanelDeps, clientesComAlerta: Set<number>) {
  const s = deps.settings();
  const agora = deps.clock();
  const hoje = localDateKey(agora, s.fuso);
  const msgs = messagesSince(deps.db, new Date(agora.getTime() - DIA)).filter(
    (m) => localDateKey(new Date(m.criadoEm), s.fuso) === hoje,
  );
  const clientes = new Set<number>();
  const comDono = new Set<number>(clientesComAlerta);
  const esperando = new Map<number, number>();
  const tempos: number[] = [];
  for (const m of msgs) {
    if (m.autor === 'cliente') {
      clientes.add(m.clienteId);
      if (!esperando.has(m.clienteId)) esperando.set(m.clienteId, new Date(m.criadoEm).getTime());
    } else {
      if (m.autor === 'dono') comDono.add(m.clienteId);
      const desde = esperando.get(m.clienteId);
      if (m.autor === 'bot' && desde !== undefined) tempos.push(Math.max(0, new Date(m.criadoEm).getTime() - desde));
      esperando.delete(m.clienteId);
    }
  }
  const total = clientes.size;
  const humanas = [...clientes].filter((c) => comDono.has(c)).length;
  const media = tempos.length > 0 ? tempos.reduce((a, b) => a + b, 0) / tempos.length / 1000 : null;
  return {
    total,
    automatico: total > 0 ? Math.round(((total - humanas) / total) * 100) : null,
    resposta: media === null ? '—' : media < 60 ? `${Math.max(1, Math.round(media))} s` : `${Math.round(media / 60)} min`,
  };
}

function conversasAtivas(deps: PanelDeps): number {
  const agora = deps.clock().getTime();
  return [...lastMessageTimes(deps.db).values()].filter((t) => agora - new Date(t).getTime() < ATIVA_MS).length;
}

/** O que a barra lateral mostra em todas as telas. */
export function resumoBot(deps: PanelDeps) {
  const abertos = new Set(deps.alerts.listOpen().flatMap((a) => (a.clienteId === null ? [] : [a.clienteId])));
  const ativas = conversasAtivas(deps);
  const { automatico } = conversasDeHoje(deps, abertos);
  return {
    titulo: ativas > 0 ? `Atendendo ${plural(ativas, 'conversa', 'conversas')}` : 'Nenhuma conversa agora',
    sub: automatico === null ? 'Sem conversas hoje' : `${automatico}% resolvidas sem você hoje`,
  };
}

function horasDoDia(deps: PanelDeps, pedidos: Order[]) {
  const s = deps.settings();
  const agora = deps.clock();
  const contagem = new Map<number, number>();
  for (const o of pedidos) {
    const h = localHour(new Date(o.criadoEm), s.fuso);
    contagem.set(h, (contagem.get(h) ?? 0) + 1);
  }
  const hoje = todayHours(s, agora);
  const horasComPedido = [...contagem.keys()];
  const de = Math.min(hoje ? Number(hoje.abre.slice(0, 2)) : HORAS_PADRAO.de, ...horasComPedido);
  const ate = Math.max(hoje ? Number(hoje.fecha.slice(0, 2)) : HORAS_PADRAO.ate, ...horasComPedido);
  const atual = localHour(agora, s.fuso);
  const max = Math.max(1, ...contagem.values());
  const barras = [];
  for (let h = de; h <= ate; h++) {
    const v = contagem.get(h) ?? 0;
    barras.push({ rotulo: `${h}h`, valor: v === 0 ? '' : String(v), altura: `${Math.round((v / max) * 84)}%`, atual: h === atual, futura: h > atual });
  }
  const pico = [...contagem.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return { barras, pico: pico ? `${pico[0]}h (${plural(pico[1], 'pedido', 'pedidos')})` : 'sem pedidos ainda' };
}

export function centralData(deps: PanelDeps) {
  const s = deps.settings();
  const agora = deps.clock();
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: s.fuso, hour: '2-digit', minute: '2-digit' });
  const data = new Intl.DateTimeFormat('pt-BR', { timeZone: s.fuso, day: 'numeric', month: 'long' });
  const nome = (clienteId: number): string => {
    const c = getCustomer(deps.db, clienteId);
    return c?.nome?.trim() || (c ? formatPhone(c.telefone) : `Cliente ${clienteId}`);
  };
  const itens = (o: Order): string => `${o.quantidade}× P13 ${o.modo}`;
  const atrasado = (o: Order): boolean => minutesSince(new Date(o.criadoEm), agora) > s.previsaoEntregaMin;

  const doDia = listOrdersByLocalDay(deps.db, localDateKey(agora, s.fuso), s.fuso);
  const validos = doDia.filter((o) => o.status !== 'cancelado');
  const abertos = listOpenOrders(deps.db);
  const esperando = abertos.filter((o) => o.status === 'recebido').sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
  const naRua = abertos.filter((o) => o.status === 'saiu');
  const agendados = abertos.filter((o) => o.status === 'agendado');

  const faturamento = validos.reduce((n, o) => n + o.totalCentavos, 0);
  const entregues = doDia.filter((o) => o.status === 'entregue' && o.finalizadoEm);
  const tempoMedio =
    entregues.length > 0
      ? Math.round(
          entregues.reduce((n, o) => n + new Date(o.finalizadoEm!).getTime() - new Date(o.criadoEm).getTime(), 0) / entregues.length / MIN,
        )
      : null;
  const botijoes = validos.reduce((n, o) => n + o.quantidade, 0);
  const kpis = [
    { rotulo: 'Pedidos hoje', valor: String(validos.length), nota: plural(botijoes, 'botijão', 'botijões') },
    {
      rotulo: 'Faturamento hoje',
      valor: formatBRL(faturamento),
      nota: validos.length > 0 ? `Ticket médio ${formatBRL(Math.round(faturamento / validos.length))}` : 'Nenhuma venda ainda',
    },
    { rotulo: 'Tempo médio de entrega', valor: tempoMedio === null ? '—' : `${tempoMedio} min`, nota: `Previsão: ${s.previsaoEntregaMin} min` },
    {
      rotulo: 'Em andamento',
      valor: String(esperando.length + naRua.length + agendados.length),
      nota: `${esperando.length} esperando · ${naRua.length} na rua · ${agendados.length} agendados`,
    },
  ];

  // Quem precisa de uma pessoa vem primeiro: alertas e conversas que o dono assumiu com o cliente esperando.
  const alertas = deps.alerts.listOpen();
  const atencao: Item[] = alertas.map((a) => {
    const c = a.clienteId !== null ? getCustomer(deps.db, a.clienteId) : null;
    const conversa = c && !c.telefone.startsWith('excluido-') ? c.id : null;
    return {
      tom: 'alerta',
      icone: 'atendente',
      titulo: c ? nome(c.id) : a.motivo,
      sub: c ? a.motivo : a.resumo,
      tempo: ago(new Date(a.criadoEm), agora),
      acao: conversa === null ? { rotulo: 'Ver', href: '/painel/alertas' } : { rotulo: 'Responder', href: `/painel/conversas/${conversa}` },
    };
  });
  const comAlerta = new Set(alertas.flatMap((a) => (a.clienteId === null ? [] : [a.clienteId])));
  const ultimas = lastMessages(deps.db);
  const assumidas = listCustomers(deps.db).filter(
    (c) => !c.telefone.startsWith('excluido-') && c.botPausadoAte !== null && new Date(c.botPausadoAte) > agora,
  );
  for (const c of assumidas) {
    const m = ultimas.get(c.id);
    if (m?.autor !== 'cliente' || comAlerta.has(c.id)) continue;
    atencao.push({
      tom: 'alerta',
      icone: 'atendente',
      titulo: nome(c.id),
      sub: m.texto,
      tempo: ago(new Date(m.criadoEm), agora),
      acao: { rotulo: 'Responder', href: `/painel/conversas/${c.id}` },
    });
  }
  const conversasEsperando = atencao.length;
  for (const o of esperando) {
    atencao.push({
      tom: atrasado(o) ? 'alerta' : 'neutro',
      icone: 'sino',
      titulo: `Pedido #${o.id} · ${nome(o.clienteId)}`,
      sub: `${itens(o)}${o.endereco ? ` · ${o.endereco.bairro}` : ''}`,
      tempo: `${minutesSince(new Date(o.criadoEm), agora)} min`,
      acao: { rotulo: 'Ver', href: '/painel/pedidos' },
    });
  }
  for (const o of naRua.filter(atrasado)) {
    atencao.push({
      tom: 'alerta',
      icone: 'relogio',
      titulo: `Pedido #${o.id} na rua há ${minutesSince(new Date(o.criadoEm), agora)} min`,
      sub: `${nome(o.clienteId)}${o.endereco ? ` · ${o.endereco.bairro}` : ''}`,
      tempo: '',
      acao: { rotulo: 'Ver', href: '/painel/pedidos' },
    });
  }

  const partes: string[] = [];
  if (esperando.length > 0) partes.push(plural(esperando.length, 'pedido esperando sair', 'pedidos esperando sair'));
  if (conversasEsperando > 0) partes.push(plural(conversasEsperando, 'conversa precisa de você', 'conversas precisam de você'));
  if (naRua.length > 0) partes.push(`${naRua.length} na rua agora`);
  const situacao = partes.length > 0 ? partes.join(' · ') : 'Tudo sob controle, nenhuma pendência no momento';
  const loja = storeStatus(s, agora);
  const briefing = loja.aberta ? situacao : `Loja fechada: o bot informa o horário e agenda pedidos para a abertura. ${situacao}`;

  const conversas = conversasDeHoje(deps, comAlerta);
  const CIRCUNFERENCIA = 2 * Math.PI * 56;

  // Não há um registro de eventos: a atividade sai dos horários gravados em cada pedido e dos alertas abertos.
  const eventos: { em: Date; texto: string }[] = [];
  for (const o of doDia) {
    eventos.push({ em: new Date(o.criadoEm), texto: `Pedido #${o.id} registrado: ${nome(o.clienteId)}, ${itens(o)}` });
    if (o.saiuEm) {
      const entregador = o.entregadorTelefone ? s.entregadores.find((e) => samePhone(e.telefone, o.entregadorTelefone!))?.nome : undefined;
      eventos.push({ em: new Date(o.saiuEm), texto: `Pedido #${o.id} saiu${entregador ? ` com ${entregador}` : ' para entrega'}` });
    }
    if (o.finalizadoEm) {
      const fim = { entregue: 'entregue', retirado: 'retirado', cancelado: 'cancelado' }[o.status as 'entregue' | 'retirado' | 'cancelado'];
      if (fim) eventos.push({ em: new Date(o.finalizadoEm), texto: `Pedido #${o.id} ${fim}` });
    }
  }
  for (const a of alertas) eventos.push({ em: new Date(a.criadoEm), texto: a.motivo });

  return {
    saudacao: `Hoje, ${data.format(agora)}`,
    briefing,
    kpis,
    atencao: atencao.slice(0, MAX_ATENCAO),
    atencaoTotal: atencao.length === 0 ? '' : plural(atencao.length, 'item', 'itens'),
    horas: horasDoDia(deps, validos),
    assistente: {
      automatico: conversas.automatico,
      traco: `${(CIRCUNFERENCIA * (conversas.automatico ?? 0)) / 100} ${CIRCUNFERENCIA}`,
      numeros: [
        { rotulo: 'Conversas hoje', valor: String(conversas.total), alerta: false },
        { rotulo: 'Conversas ativas', valor: String(conversasAtivas(deps)), alerta: false },
        { rotulo: 'Tempo de resposta', valor: conversas.resposta, alerta: false },
        { rotulo: 'Aguardando você', valor: String(conversasEsperando), alerta: conversasEsperando > 0 },
      ],
    },
    atividade: eventos
      .sort((a, b) => b.em.getTime() - a.em.getTime())
      .slice(0, MAX_ATIVIDADE)
      .map((e) => ({ hora: hora.format(e.em), texto: e.texto })),
  };
}
