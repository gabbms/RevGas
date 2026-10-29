import type { FastifyInstance, FastifyReply } from 'fastify';
import { formatBRL } from '../domain/money.js';
import { nextReorderDate } from '../domain/reminders.js';
import { formatAddress } from '../orders/dispatcher.js';
import { deleteCustomerData, getCustomer, listCustomers, type Customer } from '../store/customers.js';
import { deliveredOrderDates, listOrdersByCustomer } from '../store/orders.js';
import { renderPage, type PanelDeps } from './auth.js';
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

  scope.get('/painel/clientes', async (req, reply) => {
    const raw = (req.query as { q?: unknown }).q;
    const q = typeof raw === 'string' ? raw.trim() : '';
    const termo = q.toLowerCase();
    const digitos = q.replace(/\D/g, '');
    const clientes = listCustomers(deps.db)
      .filter((c) => !isDeleted(c))
      .filter(
        (c) =>
          q === '' ||
          (c.nome ?? '').toLowerCase().includes(termo) ||
          (digitos !== '' && c.telefone.includes(digitos)),
      )
      .map((c) => ({ id: c.id, nome: c.nome?.trim() || 'Sem nome', telefone: c.telefone }));
    return renderPage(deps, reply, 'clientes.eta', 'clientes', { titulo: 'Clientes', clientes, q });
  });

  scope.get('/painel/clientes/:id', async (req, reply) => {
    const c = customerFromParams(deps, req.params);
    if (!c) return naoEncontrado(reply);
    const s = deps.settings();
    const data = new Intl.DateTimeFormat('pt-BR', { timeZone: s.fuso, day: '2-digit', month: '2-digit', year: 'numeric' });
    const proxima = nextReorderDate(deliveredOrderDates(deps.db, c.id));
    const pedidos = listOrdersByCustomer(deps.db, c.id).map((o) => ({
      id: o.id,
      data: data.format(new Date(o.criadoEm)),
      resumo: `${o.quantidade} × P13 (${o.modo === 'troca' ? 'troca' : 'completo'})`,
      pagamento: PAYMENT_LABEL[o.pagamento],
      total: formatBRL(o.totalCentavos),
      status: STATUS_LABEL[o.status],
    }));
    return renderPage(deps, reply, 'cliente.eta', 'clientes', {
      titulo: displayName(c),
      cliente: { id: c.id, nome: c.nome?.trim() || 'Sem nome', telefone: c.telefone },
      endereco: c.endereco ? formatAddress(c.endereco) : null,
      proximaRecompra: proxima ? data.format(proxima) : '—',
      lembretes: c.lembretesDesativados ? 'desligados' : 'ligados',
      pedidos,
    });
  });

  scope.post('/painel/clientes/:id/excluir', async (req, reply) => {
    const c = customerFromParams(deps, req.params);
    if (c) deleteCustomerData(deps.db, c.id);
    return reply.redirect('/painel/clientes');
  });
}
