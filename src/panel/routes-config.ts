import type { FastifyInstance } from 'fastify';
import { updateSettings } from '../store/settings.js';
import { renderPage, type PanelDeps } from './auth.js';
import { DIAS, PAGAMENTOS, parseConfigForm, settingsToForm, type FormErrors, type FormValues } from './config-form.js';

export function registerConfigRoutes(scope: FastifyInstance, deps: PanelDeps): void {
  const pagina = (
    reply: Parameters<typeof renderPage>[1],
    valores: FormValues,
    extra: { erros?: FormErrors; salvo?: boolean } = {},
  ) =>
    renderPage(deps, reply, 'config.eta', 'config', {
      titulo: 'Configurações',
      v: valores,
      erros: extra.erros ?? {},
      salvo: extra.salvo ?? false,
      dias: DIAS,
      pagamentos: PAGAMENTOS,
    });

  scope.get('/painel/config', async (_req, reply) => pagina(reply, settingsToForm(deps.settings())));

  scope.post('/painel/config', async (req, reply) => {
    const r = parseConfigForm((req.body ?? {}) as Record<string, unknown>);
    if (!r.ok) return pagina(reply.code(422), r.valores, { erros: r.erros });
    const salvo = updateSettings(deps.db, r.settings);
    return pagina(reply, settingsToForm(salvo), { salvo: true });
  });
}
