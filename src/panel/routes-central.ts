import type { FastifyInstance } from 'fastify';
import { renderPage, type PanelDeps } from './auth.js';
import { centralData } from './central-data.js';
import { ICONS } from './icons.js';

export function registerCentralRoutes(scope: FastifyInstance, deps: PanelDeps): void {
  scope.get('/painel', async (_req, reply) =>
    renderPage(deps, reply, 'central.eta', 'central', { titulo: 'Central', icons: ICONS, ...centralData(deps) }),
  );

  // Fragmento que o htmx busca a cada 10 s.
  scope.get('/painel/central', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').view('_central.eta', { icons: ICONS, ...centralData(deps) }),
  );
}
