import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import { parseWebhook, verifySignature, type InboundEvent } from './whatsapp/webhook.js';

export interface AppDeps {
  env: Env;
  onInbound(events: InboundEvent[]): Promise<void>;
  registerPanel?(app: FastifyInstance): Promise<void>;
  /** Log de requisições do Fastify (sem corpo de mensagens). Desligado por padrão. */
  logger?: boolean;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env } = deps;
  // Atrás do Caddy (no mesmo host), o IP real do cliente vem no X-Forwarded-For; só confiamos no proxy local.
  // O limitador de login do painel conta tentativas por esse IP.
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: 'loopback' });

  // Corpo cru em Buffer: a assinatura da Meta é calculada sobre os bytes exatos.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const raw = body as Buffer;
    (req as { rawBody?: Buffer }).rawBody = raw;
    if (raw.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(raw.toString('utf8')));
    } catch {
      // Lixo sem assinatura válida é 401 (tratado no handler), não 400.
      const h = req.headers['x-hub-signature-256'];
      if (req.url.startsWith('/webhook') && !verifySignature(raw, typeof h === 'string' ? h : undefined, env.WA_APP_SECRET)) {
        return done(null, undefined);
      }
      const err = Object.assign(new Error('JSON inválido'), { statusCode: 400 });
      done(err, undefined);
    }
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/webhook', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === env.WA_VERIFY_TOKEN && q['hub.challenge'] !== undefined) {
      return reply.code(200).type('text/plain').send(q['hub.challenge']);
    }
    return reply.code(403).send();
  });

  app.post('/webhook', async (req, reply) => {
    const raw = (req as { rawBody?: Buffer }).rawBody;
    const header = req.headers['x-hub-signature-256'];
    if (!raw || !verifySignature(raw, typeof header === 'string' ? header : undefined, env.WA_APP_SECRET)) {
      return reply.code(401).send();
    }
    const events = parseWebhook(req.body);
    if (events.length > 0) {
      // Responde 200 já; o processamento segue em segundo plano.
      void Promise.resolve()
        .then(() => deps.onInbound(events))
        .catch((err: unknown) => {
          app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'falha ao processar mensagens recebidas');
        });
    }
    return reply.code(200).send();
  });

  if (deps.registerPanel) await deps.registerPanel(app);
  return app;
}
