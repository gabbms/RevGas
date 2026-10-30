import type { FastifyInstance, FastifyReply } from 'fastify';
import { formatBRL } from '../domain/money.js';
import { nextReorderDate } from '../domain/reminders.js';
import { formatAddress } from '../orders/dispatcher.js';
import { deleteCustomerData, getCustomer, listCustomers, type Customer } from '../store/customers.js';
import { deliveredOrderDates, listOrdersByCustomer } from '../store/orders.js';
import { renderPage, type PanelDeps } from './auth.js';
import { formatPhone } from './format.js';
import { PAYMENT_LABEL, STATUS_LABEL } from './labels.js';

export const isDeleted = (c: Customer): boolean => c.telefone.startsWith('excluido-');
export const displayName = (c: Customer): string => c.nome?.trim() || c.telefone;

/** Cliente da URL (`:id`), ou null se não existir ou já tiver sido excluído. */
export function customerFromParams(deps: PanelDeps, params: unknown): Customer | null {
  const id = Number((params as { id?: string }).id);
  if (!Number.isInteger(id)) return null;
  const c = getCustomer(deps.db, id);
  return c && !isDeleted(c) ? c : null;
}

export function registerCustomerRoutes(scope: FastifyInstance, deps: PanelDeps): void {
  const naoEncontrado = (reply: FastifyReply) =>
    renderPage(deps, reply.code(404), 'nao-encontrado.eta', 'clientes', { titulo: 'Não encontrado' });

  const formatos = () => {
    const fuso = deps.settings().fuso;
    return {
      data: new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', year: 'numeric' }),
      curta: new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit' }),
    };
  };

  scope.get('/painel/clientes', async (req, reply) => {
    const raw = (req.query as { q?: unknown }).q;
    const q = typeof raw === 'string' ? raw.trim() : '';
    const termo = q.toLowerCase();
    const digitos = q.replace(/\D/g, '');
    const { curta } = formatos();
    const todos = listCustomers(deps.db).filter((c) => !isDeleted(c));
    const clientes = todos
      .filter(
        (c) =>
          q === '' ||
          (c.nome ?? '').toLowerCase().includes(termo) ||
          (digitos !== '' && c.telefone.includes(digitos)),
      )
      .map((c) => {
        const pedidos = listOrdersByCustomer(deps.db, c.id).filter((o) => o.status !== 'cancelado');
        const ultimo = pedidos.reduce<string | null>((m, o) => (m === null || o.criadoEm > m ? o.criadoEm : m), null);
        const proxima = nextReorderDate(deliveredOrderDates(deps.db, c.id));
        return {
          id: c.id,
          nome: c.nome?.trim() || 'Sem nome',
          telefone: formatPhone(c.telefone),
          bairro: c.endereco?.bairro ?? null,
          pedidos: pedidos.length,
          ultimo: ultimo ? curta.format(new Date(ultimo)) : null,
          ultimoIso: ultimo ?? '',
          proxima: proxima ? curta.format(proxima) : null,
        };
      })
      // Quem comprou por último aparece primeiro; quem nunca comprou vai para o fim.
      .sort((x, y) => y.ultimoIso.localeCompare(x.ultimoIso));
    return renderPage(deps, reply, 'clientes.eta', 'clientes', { titulo: 'Clientes', clientes, q, total: todos.length });
  });

  scope.get('/painel/clientes/:id', async (req, reply) => {
    const c = customerFromParams(deps, req.params);
    if (!c) return naoEncontrado(reply);
    const { data } = formatos();
    const proxima = nextReorderDate(deliveredOrderDates(deps.db, c.id));
    const todos = listOrdersByCustomer(deps.db, c.id);
    const validos = todos.filter((o) => o.status !== 'cancelado');
    const pedidos = todos.map((o) => ({
      id: o.id,
      data: data.format(new Date(o.criadoEm)),
      resumo: `${o.quantidade} × P13 ${o.modo === 'troca' ? 'troca' : 'completo'}`,
      pagamento: PAYMENT_LABEL[o.pagamento],
      total: formatBRL(o.totalCentavos),
      status: o.status,
      statusRotulo: o.status === 'saiu' ? 'Na rua' : STATUS_LABEL[o.status],
    }));
    return renderPage(deps, reply, 'cliente.eta', 'clientes', {
      titulo: displayName(c),
      cliente: { id: c.id, nome: c.nome?.trim() || 'Sem nome', telefone: formatPhone(c.telefone) },
      endereco: c.endereco ? formatAddress(c.endereco) : null,
      proximaRecompra: proxima ? data.format(proxima) : '—',
      lembretes: c.lembretesDesativados ? 'desligados' : 'ligados',
      resumo: {
        pedidos: validos.length,
        botijoes: validos.reduce((n, o) => n + o.quantidade, 0),
        gasto: formatBRL(validos.reduce((n, o) => n + o.totalCentavos, 0)),
      },
      pedidos,
    });
  });

  scope.post('/painel/clientes/:id/excluir', async (req, reply) => {
    const c = customerFromParams(deps, req.params);
    if (c) deleteCustomerData(deps.db, c.id);
    return reply.redirect('/painel/clientes');
  });
}
