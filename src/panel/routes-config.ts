import type { FastifyInstance } from 'fastify';
import { missingTemplates } from '../config/env.js';
import { updateSettings, type StoreSettings } from '../store/settings.js';
import { renderPage, type PanelDeps } from './auth.js';
import { DIAS, PAGAMENTOS, parseConfigForm, settingsToForm, type FormErrors, type FormValues } from './config-form.js';

/** Problemas do que está salvo agora, que fazem o bot atender mal mesmo sem erro no formulário. */
export function settingsWarnings(s: StoreSettings): string[] {
  const avisos: string[] = [];
  if (Object.values(s.horarios).every((h) => h === null)) {
    avisos.push('A loja está fechada todos os dias: o bot só agenda pedidos e nunca promete entrega. Preencha o horário abaixo.');
  }
  if (s.destinoPedidos === 'dono' && s.telefoneDono.trim() === '') {
    avisos.push('Os pedidos vão para o seu WhatsApp, mas ele não está preenchido: nenhum pedido chega a ninguém.');
  }
  if (s.destinoPedidos === 'entregadores' && s.entregadores.length === 0) {
    avisos.push('Os pedidos vão para os entregadores, mas nenhum está cadastrado: nenhum pedido chega a ninguém.');
  }
  return avisos;
}

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
      modelosFaltando: missingTemplates(deps.env),
      avisos: settingsWarnings(deps.settings()),
    });

  scope.get('/painel/config', async (_req, reply) => pagina(reply, settingsToForm(deps.settings())));

  scope.post('/painel/config', async (req, reply) => {
    const r = parseConfigForm((req.body ?? {}) as Record<string, unknown>);
    if (!r.ok) return pagina(reply.code(422), r.valores, { erros: r.erros });
    const salvo = updateSettings(deps.db, r.settings);
    return pagina(reply, settingsToForm(salvo), { salvo: true });
  });
}
