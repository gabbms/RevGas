import type { FastifyInstance, FastifyReply } from 'fastify';
import { localDateKey } from '../domain/hours.js';
import { getCustomer, listCustomers, updateCustomer, type Customer } from '../store/customers.js';
import { formatBRL } from '../domain/money.js';
import { insertMessage, lastMessages, recentMessages } from '../store/messages.js';
import { openOrdersFor } from '../store/orders.js';
import { renderPage, type PanelDeps } from './auth.js';
import { ago, formatPhone } from './format.js';
import { ICONS } from './icons.js';
import { STATUS_LABEL } from './labels.js';
import { customerFromParams, isDeleted } from './routes-customers.js';

/** Quanto tempo o bot fica quieto depois que o dono assume a conversa. */
export const PAUSA_DONO_MS = 2 * 60 * 60 * 1000;
const JANELA_HISTORICO_MS = 30 * 24 * 60 * 60 * 1000;
const LIMITE_MENSAGENS = 200;

const AVISO_FORA_DA_JANELA =
  'O cliente não fala com o bot há mais de 24h. O WhatsApp só permite responder depois que ele mandar uma mensagem.';
const AVISO_ERRO_API = 'Não foi possível enviar agora. Tente de novo.';
const AVISO_VAZIO = 'Escreva a mensagem antes de enviar.';

const nomeOuTelefone = (c: Customer): string => c.nome?.trim() || formatPhone(c.telefone);

export function registerConversationRoutes(scope: FastifyInstance, deps: PanelDeps): void {
  const pausado = (c: Customer): boolean => !!c.botPausadoAte && new Date(c.botPausadoAte) > deps.clock();

  function formatoHora(): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: deps.settings().fuso,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** Hora de hoje sem a data ("13:36"); de outros dias, com ela ("29/10, 13:36"). */
  function horaCurta(): (d: Date) => string {
    const fuso = deps.settings().fuso;
    const hoje = localDateKey(deps.clock(), fuso);
    const so = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit' });
    const comData = formatoHora();
    return (d) => (localDateKey(d, fuso) === hoje ? so.format(d) : comData.format(d));
  }

  function mensagens(c: Customer) {
    const fmt = horaCurta();
    const desde = new Date(deps.clock().getTime() - JANELA_HISTORICO_MS);
    return recentMessages(deps.db, c.id, desde, LIMITE_MENSAGENS).map((m) => ({
      autor: m.autor,
      rotulo: m.autor === 'cliente' ? nomeOuTelefone(c) : m.autor === 'bot' ? 'Bot' : 'Você',
      audio: m.tipo === 'audio',
      texto: m.texto,
      quando: fmt(new Date(m.criadoEm)),
    }));
  }

  /** A caixa de conversas: a mais recente primeiro, com a prévia da última mensagem. */
  function lista() {
    const ultimas = lastMessages(deps.db);
    const agora = deps.clock();
    return listCustomers(deps.db)
      .filter((c) => !isDeleted(c) && ultimas.has(c.id))
      .sort((a, b) => {
        const x = ultimas.get(a.id)!;
        const y = ultimas.get(b.id)!;
        return y.criadoEm.localeCompare(x.criadoEm) || y.id - x.id;
      })
      .map((c) => {
        const m = ultimas.get(c.id)!;
        const quem = m.autor === 'bot' ? 'Bot: ' : m.autor === 'dono' ? 'Você: ' : '';
        return {
          id: c.id,
          nome: nomeOuTelefone(c),
          telefone: formatPhone(c.telefone),
          ultima: ago(new Date(m.criadoEm), agora),
          previa: quem + (m.tipo === 'audio' ? 'Áudio: ' : '') + m.texto,
          pausado: pausado(c),
          // O dono assumiu e a última fala é do cliente: alguém precisa responder.
          esperandoVoce: pausado(c) && m.autor === 'cliente',
        };
      });
  }

  function paginaConversa(
    reply: FastifyReply,
    escolhida: Customer | null,
    extra: { erro?: string; texto?: string } = {},
  ) {
    const conversas = lista();
    // Sem conversa escolhida, o computador já abre a mais recente; no celular a lista vem primeiro.
    const c = escolhida ?? (conversas[0] ? getCustomer(deps.db, conversas[0].id) : null);
    if (!c) {
      return renderPage(deps, reply, 'conversa.eta', 'conversas', { titulo: 'Conversas', conversas, selecionada: null, automatica: false });
    }
    return renderPage(deps, reply, 'conversa.eta', 'conversas', {
      titulo: escolhida ? nomeOuTelefone(c) : 'Conversas',
      conversas,
      selecionada: c.id,
      automatica: escolhida === null,
      cliente: { id: c.id, nome: nomeOuTelefone(c), telefone: formatPhone(c.telefone) },
      pedidos: openOrdersFor(deps.db, c.id).map((o) => ({
        id: o.id,
        status: o.status === 'saiu' ? 'Na rua' : STATUS_LABEL[o.status],
        resumo: `${o.quantidade} × P13 ${o.modo === 'troca' ? 'troca' : 'completo'}`,
        total: formatBRL(o.totalCentavos),
      })),
      pausado: pausado(c),
      pausadoAte: pausado(c) ? horaCurta()(new Date(c.botPausadoAte!)) : null,
      mensagens: mensagens(c),
      erro: extra.erro ?? null,
      texto: extra.texto ?? '',
    });
  }

  const naoEncontrado = (reply: FastifyReply) =>
    renderPage(deps, reply.code(404), 'nao-encontrado.eta', 'conversas', { titulo: 'Não encontrado' });

  const pausarPor = (c: Customer) =>
    updateCustomer(deps.db, c.id, { botPausadoAte: new Date(deps.clock().getTime() + PAUSA_DONO_MS).toISOString() });

  scope.get('/painel/conversas', async (_req, reply) => paginaConversa(reply, null));

  scope.get('/painel/conversas/:id', async (req, reply) => {
    const c = customerFromParams(deps, req.params);
    return c ? paginaConversa(reply, c) : naoEncontrado(reply);
  });

  // Fragmento que o htmx troca a cada 5 s.
  scope.get('/painel/conversas/:id/mensagens', async (req, reply) => {
    const c = customerFromParams(deps, req.params);
    if (!c) return reply.code(404).type('text/html; charset=utf-8').send('');
    return reply.type('text/html; charset=utf-8').view('conversa-mensagens.eta', { mensagens: mensagens(c), icons: ICONS });
  });

  scope.post('/painel/conversas/:id/responder', async (req, reply) => {
    const c = customerFromParams(deps, req.params);
    if (!c) return naoEncontrado(reply);
    const bruto = (req.body as { texto?: unknown } | undefined)?.texto;
    const texto = typeof bruto === 'string' ? bruto.trim() : '';
    if (texto === '') return paginaConversa(reply, c, { erro: AVISO_VAZIO });

    const r = await deps.outbox.send({ telefone: c.telefone, texto });
    if (!r.ok) {
      const erro = r.motivo === 'fora_da_janela' ? AVISO_FORA_DA_JANELA : AVISO_ERRO_API;
      return paginaConversa(reply, c, { erro, texto });
    }
    insertMessage(deps.db, {
      clienteId: c.id,
      autor: 'dono',
      tipo: 'texto',
      texto,
      wamid: r.wamid,
      criadoEm: deps.clock().toISOString(),
    });
    pausarPor(c);
    return reply.redirect(`/painel/conversas/${c.id}`);
  });

  scope.post('/painel/conversas/:id/pausar', async (req, reply) => {
    const c = customerFromParams(deps, req.params);
    if (c) pausarPor(c);
    return reply.redirect(c ? `/painel/conversas/${c.id}` : '/painel/conversas');
  });

  scope.post('/painel/conversas/:id/devolver', async (req, reply) => {
    const c = customerFromParams(deps, req.params);
    if (c) updateCustomer(deps.db, c.id, { botPausadoAte: null });
    return reply.redirect(c ? `/painel/conversas/${c.id}` : '/painel/conversas');
  });
}
