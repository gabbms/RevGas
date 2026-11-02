import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import { parseWahaWebhook, verifyWahaSecret } from './whatsapp/waha.js';
import { parseWebhook, verifySignature, type InboundEvent } from './whatsapp/webhook.js';

export interface AppDeps {
  env: Env;
  onInbound(events: InboundEvent[]): Promise<void>;
  /** WAHA: descobre o telefone de um contato `@lid`. */
  resolveLid?(lid: string): Promise<string | undefined>;
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
      if (req.url.startsWith('/webhook') && env.WA_APP_SECRET && !verifySignature(raw, typeof h === 'string' ? h : undefined, env.WA_APP_SECRET)) {
        return done(null, undefined);
      }
      const err = Object.assign(new Error('JSON inválido'), { statusCode: 400 });
      done(err, undefined);
    }
  });

  app.get('/healthz', async () => ({ ok: true }));

  const entregar = (events: InboundEvent[]): void => {
    if (events.length === 0) return;
    // Responde 200 já; o processamento segue em segundo plano.
    void Promise.resolve()
      .then(() => deps.onInbound(events))
      .catch((err: unknown) => {
        app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'falha ao processar mensagens recebidas');
      });
  };

  const { WA_APP_SECRET: appSecret, WA_VERIFY_TOKEN: verifyToken, WAHA_WEBHOOK_SECRET: wahaSecret } = env;

  if (env.WA_PROVIDER === 'meta' && appSecret && verifyToken) {
    app.get('/webhook', async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === verifyToken && q['hub.challenge'] !== undefined) {
        return reply.code(200).type('text/plain').send(q['hub.challenge']);
      }
      return reply.code(403).send();
    });

    app.post('/webhook', async (req, reply) => {
      const raw = (req as { rawBody?: Buffer }).rawBody;
      const header = req.headers['x-hub-signature-256'];
      if (!raw || !verifySignature(raw, typeof header === 'string' ? header : undefined, appSecret)) {
        return reply.code(401).send();
      }
      entregar(parseWebhook(req.body));
      return reply.code(200).send();
    });
  }

  // WAHA (não oficial, só para testes): o segredo vai no cabeçalho X-Revgas-Secret, configurado no WAHA.
  if (env.WA_PROVIDER === 'waha' && wahaSecret) {
    app.post('/webhook/waha', async (req, reply) => {
      const header = req.headers['x-revgas-secret'];
      if (!verifyWahaSecret(typeof header === 'string' ? header : undefined, wahaSecret)) return reply.code(401).send();
      const { events, lids } = parseWahaWebhook(req.body);
      if (lids.length === 0) entregar(events);
      else {
        // Descobrir o telefone leva uma consulta ao WAHA; o 200 sai já e o resto segue em segundo plano.
        void Promise.all(
          lids.map(async ({ lid, evento }) => {
            const de = await deps.resolveLid?.(lid);
            if (de === undefined) console.warn(`waha: mensagem ignorada, não achei o telefone do contato ${lid}.`);
            return de === undefined ? [] : [{ ...evento, de }];
          }),
        ).then((resolvidos) => entregar([...events, ...resolvidos.flat()]));
      }
      return reply.code(200).send();
    });
  }

  if (deps.registerPanel) await deps.registerPanel(app);
  return app;
}
