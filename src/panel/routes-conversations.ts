import type { FastifyInstance, FastifyReply } from 'fastify';
import { listCustomers, updateCustomer, type Customer } from '../store/customers.js';
import { insertMessage, lastMessageTimes, recentMessages } from '../store/messages.js';
import { renderPage, type PanelDeps } from './auth.js';
import { customerFromParams, displayName, isDeleted } from './routes-customers.js';

/** Quanto tempo o bot fica quieto depois que o dono assume a conversa. */
export const PAUSA_DONO_MS = 2 * 60 * 60 * 1000;
const JANELA_HISTORICO_MS = 30 * 24 * 60 * 60 * 1000;
const LIMITE_MENSAGENS = 200;

const AVISO_FORA_DA_JANELA =
  'O cliente não fala com o bot há mais de 24h. O WhatsApp só permite responder depois que ele mandar uma mensagem.';
const AVISO_ERRO_API = 'Não foi possível enviar agora. Tente de novo.';
const AVISO_VAZIO = 'Escreva a mensagem antes de enviar.';

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

  function mensagens(c: Customer) {
    const fmt = formatoHora();
    const desde = new Date(deps.clock().getTime() - JANELA_HISTORICO_MS);
    return recentMessages(deps.db, c.id, desde, LIMITE_MENSAGENS).map((m) => ({
      autor: m.autor,
      rotulo: m.autor === 'cliente' ? displayName(c) : m.autor === 'bot' ? 'Bot' : 'Você',
      audio: m.tipo === 'audio',
      texto: m.texto,
      quando: fmt.format(new Date(m.criadoEm)),
    }));
  }

  function paginaConversa(reply: FastifyReply, c: Customer, extra: { erro?: string; texto?: string } = {}) {
    return renderPage(deps, reply, 'conversa.eta', 'conversas', {
      titulo: displayName(c),
      cliente: { id: c.id, nome: displayName(c) },
      pausado: pausado(c),
      pausadoAte: pausado(c) ? formatoHora().format(new Date(c.botPausadoAte!)) : null,
      mensagens: mensagens(c),
      erro: extra.erro ?? null,
      texto: extra.texto ?? '',
    });
  }

  const naoEncontrado = (reply: FastifyReply) =>
    renderPage(deps, reply.code(404), 'nao-encontrado.eta', 'conversas', { titulo: 'Não encontrado' });

  const pausarPor = (c: Customer) =>
    updateCustomer(deps.db, c.id, { botPausadoAte: new Date(deps.clock().getTime() + PAUSA_DONO_MS).toISOString() });

  scope.get('/painel/conversas', async (_req, reply) => {
    const ultimas = lastMessageTimes(deps.db);
    const fmt = formatoHora();
    const conversas = listCustomers(deps.db)
      .filter((c) => !isDeleted(c) && ultimas.has(c.id))
      .sort((a, b) => ultimas.get(b.id)!.localeCompare(ultimas.get(a.id)!))
      .map((c) => ({
        id: c.id,
        nome: displayName(c),
        telefone: c.telefone,
        ultima: fmt.format(new Date(ultimas.get(c.id)!)),
        pausado: pausado(c),
      }));
    return renderPage(deps, reply, 'conversas.eta', 'conversas', { titulo: 'Conversas', conversas });
  });

  scope.get('/painel/conversas/:id', async (req, reply) => {
    const c = customerFromParams(deps, req.params);
    return c ? paginaConversa(reply, c) : naoEncontrado(reply);
  });

  // Fragmento que o htmx troca a cada 5 s.
  scope.get('/painel/conversas/:id/mensagens', async (req, reply) => {
    const c = customerFromParams(deps, req.params);
    if (!c) return reply.code(404).type('text/html; charset=utf-8').send('');
    return reply.type('text/html; charset=utf-8').view('conversa-mensagens.eta', { mensagens: mensagens(c) });
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
