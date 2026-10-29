import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AlertService } from '../alerts/service.js';
import type { Env } from '../config/env.js';
import type { Db } from '../db/connection.js';
import type { OrderService } from '../orders/service.js';
import type { StoreSettings } from '../store/settings.js';
import type { createOutbox } from '../whatsapp/outbox.js';
import { registerConfigRoutes } from './routes-config.js';
import { registerConversationRoutes } from './routes-conversations.js';
import { registerCustomerRoutes } from './routes-customers.js';
import { registerOrderRoutes } from './routes-orders.js';

export interface PanelDeps {
  db: Db;
  env: Env;
  orders: OrderService;
  alerts: AlertService;
  outbox: ReturnType<typeof createOutbox>;
  settings: () => StoreSettings;
  clock: () => Date;
}

const VIEWS_DIR = fileURLToPath(new URL('./views', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));

const COOKIE = 'sessao';
const SESSION_VALUE = 'ok';
const THIRTY_DAYS = 30 * 24 * 60 * 60;

/** Abas da navegação. A Task 15 só precisa registrar as rotas dessas telas. */
export const NAV = [
  { id: 'pedidos', label: 'Pedidos', href: '/painel/pedidos' },
  { id: 'clientes', label: 'Clientes', href: '/painel/clientes' },
  { id: 'conversas', label: 'Conversas', href: '/painel/conversas' },
  { id: 'alertas', label: 'Alertas', href: '/painel/alertas' },
  { id: 'config', label: 'Configurações', href: '/painel/config' },
] as const;
export type NavId = (typeof NAV)[number]['id'];

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
const samePassword = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

function hasSession(req: FastifyRequest): boolean {
  const raw = req.cookies[COOKIE];
  if (!raw) return false;
  const r = req.unsignCookie(raw);
  return r.valid && r.value === SESSION_VALUE;
}

/**
 * Renderiza uma página do painel dentro do layout (navegação, contador de alertas, htmx).
 * Todas as telas do painel passam por aqui.
 */
export function renderPage(
  deps: PanelDeps,
  reply: FastifyReply,
  view: string,
  active: NavId,
  data: Record<string, unknown> = {},
) {
  return reply
    .type('text/html; charset=utf-8')
    .view(view, { ...data, nav: NAV, active, alertasAbertos: deps.alerts.listOpen().length }, { layout: 'layout.eta' });
}

export async function registerPanel(app: FastifyInstance, deps: PanelDeps): Promise<void> {
  const { env } = deps;
  const secure = env.PUBLIC_URL.startsWith('https');

  await app.register(fastifyCookie, { secret: env.SESSION_SECRET });
  await app.register(fastifyFormbody);
  // Eta escapa HTML em <%= %> por padrão; <%~ %> (sem escape) só para o corpo já renderizado.
  await app.register(fastifyView, { engine: { eta: new Eta({ views: VIEWS_DIR, autoEscape: true }) }, root: VIEWS_DIR });
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/static/' });

  app.get('/login', async (req, reply) => {
    if (hasSession(req)) return reply.redirect('/painel/pedidos');
    return reply.type('text/html; charset=utf-8').view('login.eta', { erro: null });
  });

  app.post('/login', async (req, reply) => {
    const senha = (req.body as { senha?: unknown } | undefined)?.senha;
    if (typeof senha !== 'string' || !samePassword(senha, env.PANEL_PASSWORD)) {
      return reply.code(401).type('text/html; charset=utf-8').view('login.eta', { erro: 'Senha incorreta. Tente de novo.' });
    }
    reply.setCookie(COOKIE, SESSION_VALUE, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      signed: true,
      maxAge: THIRTY_DAYS,
    });
    return reply.redirect('/painel/pedidos');
  });

  app.post('/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.redirect('/login');
  });

  // Tudo que fica sob /painel exige sessão. As rotas da Task 15 entram neste mesmo escopo.
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      if (hasSession(req)) return;
      if (req.headers['hx-request']) {
        // Atualização automática do htmx com a sessão vencida: manda o navegador inteiro ao login.
        return reply.code(401).header('HX-Redirect', '/login').send();
      }
      return reply.redirect('/login');
    });
    registerOrderRoutes(scope, deps);
    registerCustomerRoutes(scope, deps);
    registerConversationRoutes(scope, deps);
    registerConfigRoutes(scope, deps);
  });
}
