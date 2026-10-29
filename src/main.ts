import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import { createAgent, createCustomerTurnHandler } from './ai/agent.js';
import type { ToolContext } from './ai/tool-handlers.js';
import { createAlertService } from './alerts/service.js';
import { createOpenAITranscriber, type Transcriber } from './audio/transcriber.js';
import { loadEnv, type Env } from './config/env.js';
import { openDb, type Db } from './db/connection.js';
import { normalizeText } from './domain/order-validation.js';
import { runReminderJob } from './domain/reminders.js';
import { isStaffPhone } from './domain/staff-replies.js';
import { createContentToText } from './inbound/media.js';
import { createInboundRouter } from './inbound/router.js';
import { startScheduler } from './jobs/scheduler.js';
import { createWhatsAppDispatcher } from './orders/dispatcher.js';
import { createOrderService } from './orders/service.js';
import { createStaffHandler } from './orders/staff.js';
import { registerPanel } from './panel/auth.js';
import { buildApp } from './server.js';
import { hasRecentGasDoPovoDraft } from './store/drafts.js';
import { recentMessages } from './store/messages.js';
import { openOrdersFor } from './store/orders.js';
import { getSettings } from './store/settings.js';
import { createWhatsAppApi, type WhatsAppApi } from './whatsapp/api.js';
import { createOutbox } from './whatsapp/outbox.js';

const HTTP_TIMEOUT_MS = 20_000;

/** fetch que aborta após 20 s quando quem chama não passou o próprio `signal`. */
const fetchWithTimeout: typeof fetch = (input, init) =>
  fetch(input, init?.signal ? init : { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });

export interface AppOverrides {
  api?: WhatsAppApi;
  anthropic?: Anthropic;
  transcriber?: Transcriber;
  clock?: () => Date;
}

export interface AppContext {
  app: FastifyInstance;
  router: ReturnType<typeof createInboundRouter>;
  db: Db;
  hasGasDoPovoContext(clienteId: number): boolean;
  /** Liga as tarefas periódicas (só o `main` chama; os testes não ficam com timers). */
  startJobs(): void;
  /** Nulo até `startJobs()` ser chamada. */
  readonly stopScheduler: (() => void) | null;
}

export async function createAppContext(env: Env, overrides: AppOverrides = {}): Promise<AppContext> {
  const clock = overrides.clock ?? (() => new Date());
  const db = openDb(env.DB_PATH);
  const settings = () => getSettings(db);

  const api =
    overrides.api ??
    createWhatsAppApi({
      token: env.WA_TOKEN,
      phoneNumberId: env.WA_PHONE_NUMBER_ID,
      graphVersion: env.WA_GRAPH_VERSION,
      fetch: fetchWithTimeout,
    });
  const transcriber =
    overrides.transcriber ??
    createOpenAITranscriber({ apiKey: env.OPENAI_API_KEY, model: env.TRANSCRIBE_MODEL, fetch: fetchWithTimeout });
  const anthropic =
    overrides.anthropic ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 2 });

  const outbox = createOutbox(db, api, clock);
  const alerts = createAlertService({
    db,
    outbox,
    settings,
    publicUrl: env.PUBLIC_URL,
    clock,
    ...(env.WA_TPL_ALERTA ? { templateAlerta: env.WA_TPL_ALERTA } : {}),
  });
  const dispatcher = createWhatsAppDispatcher({
    db,
    outbox,
    settings,
    ...(env.WA_TPL_PEDIDO ? { templatePedido: env.WA_TPL_PEDIDO } : {}),
  });
  const orders = createOrderService({
    db,
    dispatcher,
    alerts,
    outbox,
    settings,
    clock,
    ...(env.WA_TPL_STATUS ? { templateStatus: env.WA_TPL_STATUS } : {}),
  });
  const handleStaff = createStaffHandler({ db, orders, alerts, outbox, settings });

  const agent = createAgent({
    client: anthropic,
    model: env.AI_MODEL,
    effort: env.AI_EFFORT,
    db,
    clock,
    makeContext: (clienteId): ToolContext => ({
      db,
      clienteId,
      settings,
      orders,
      alerts,
      clock,
      ultimaMensagemClienteEm: new Date(0), // o agente sobrescreve no começo de cada turno
    }),
  });
  const onCustomerTurn = createCustomerTurnHandler({ db, agent, outbox, alerts, clock });

  const GAS_DO_POVO_JANELA_MS = 2 * 60 * 60 * 1000;
  const hasGasDoPovoContext = (clienteId: number): boolean =>
    hasRecentGasDoPovoDraft(db, clienteId, clock()) ||
    openOrdersFor(db, clienteId).some((o) => o.pagamento === 'gas_do_povo') ||
    recentMessages(db, clienteId, new Date(clock().getTime() - GAS_DO_POVO_JANELA_MS)).some(
      (m) => m.autor === 'cliente' && normalizeText(m.texto).includes('gas do povo'),
    );

  const router = createInboundRouter({
    db,
    outbox,
    clock,
    isStaff: (telefone) => isStaffPhone(settings(), telefone),
    handleStaff,
    contentToText: createContentToText({ db, api, transcriber, outbox, clock }),
    onCustomerTurn,
    hasGasDoPovoContext,
    debounceMs: 2500,
  });

  const app = await buildApp({
    env,
    // Sem corpo de requisição nos logs (o Fastify só registra método, URL e status).
    logger: process.env.NODE_ENV === 'production',
    onInbound: (events) => router.handle(events),
    registerPanel: (a) => registerPanel(a, { db, env, orders, alerts, outbox, settings, clock }),
  });

  let stop: (() => void) | null = null;
  return {
    app,
    router,
    db,
    hasGasDoPovoContext,
    startJobs() {
      if (stop) return;
      stop = startScheduler({
        orders,
        clock,
        reminders: () =>
          runReminderJob({
            db,
            outbox,
            settings,
            clock,
            ...(env.WA_TPL_LEMBRETE ? { templateLembrete: env.WA_TPL_LEMBRETE } : {}),
          }),
      });
    },
    get stopScheduler() {
      return stop;
    },
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const ctx = await createAppContext(env);
  ctx.startJobs();

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`${signal} recebido, encerrando...`);
    try {
      ctx.stopScheduler?.();
      await ctx.app.close();
      ctx.db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await ctx.app.listen({ port: env.PORT, host: '0.0.0.0' });
}

// Só sobe o servidor quando executado diretamente (importar em testes não escuta porta).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('falha ao iniciar:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
