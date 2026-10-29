import type { FastifyInstance } from 'fastify';
import { createAlertService } from '../../src/alerts/service.js';
import { loadEnv } from '../../src/config/env.js';
import { openDb } from '../../src/db/connection.js';
import { createWhatsAppDispatcher } from '../../src/orders/dispatcher.js';
import { createOrderService } from '../../src/orders/service.js';
import { registerPanel } from '../../src/panel/auth.js';
import { buildApp } from '../../src/server.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../../src/store/settings.js';
import { updateCustomer, upsertCustomerByPhone } from '../../src/store/customers.js';
import { createOutbox } from '../../src/whatsapp/outbox.js';
import { FakeWhatsApp } from '../fakes/fake-whatsapp.js';

export const SENHA = 'senha-do-dono';
export const SEGUNDA_10H = new Date('2026-11-02T13:00:00Z');
export const env = loadEnv({
  PUBLIC_URL: 'https://loja.exemplo',
  WA_TOKEN: 't',
  WA_PHONE_NUMBER_ID: '1',
  WA_APP_SECRET: 's',
  WA_VERIFY_TOKEN: 'v',
  ANTHROPIC_API_KEY: 'k',
  OPENAI_API_KEY: 'k',
  PANEL_PASSWORD: SENHA,
  SESSION_SECRET: 'x'.repeat(32),
});

export async function setupPanel(nomeCliente = 'Maria', clock: () => Date = () => SEGUNDA_10H) {
  const db = openDb(':memory:');
  updateSettings(db, {
    ...DEFAULT_SETTINGS,
    precoRecargaCentavos: 11500,
    precoCompletoCentavos: 32000,
    bairros: ['Centro'],
    pagamentos: ['dinheiro', 'cartao', 'pix_entrega', 'pix_antecipado', 'gas_do_povo'],
    chavePix: 'cnpj 00.000.000/0001-00',
    telefoneDono: '5586999990000',
    entregadores: [{ nome: 'João', telefone: '5586911110000' }],
    destinoPedidos: 'entregadores',
    gasDoPovo: { aceita: true, modalidade: 'entrega', taxaEntregaCentavos: 500 },
  });
  const settings = () => getSettings(db);
  const fake = new FakeWhatsApp();
  const outbox = createOutbox(db, fake, clock);
  const cliente = updateCustomer(db, upsertCustomerByPhone(db, '5586988887777', SEGUNDA_10H).id, { nome: nomeCliente });
  outbox.registerInbound(cliente.telefone, SEGUNDA_10H);
  outbox.registerInbound('5586911110000', SEGUNDA_10H);
  const alerts = createAlertService({ db, outbox, settings, publicUrl: env.PUBLIC_URL, clock });
  const dispatcher = createWhatsAppDispatcher({ db, outbox, settings });
  const orders = createOrderService({ db, dispatcher, alerts, outbox, settings, clock });
  const app = await buildApp({
    env,
    onInbound: async () => {},
    registerPanel: (a) => registerPanel(a, { db, env, orders, alerts, outbox, settings, clock }),
  });
  return { app, db, orders, alerts, cliente, fake };
}

/** Faz login e devolve o valor do cabeçalho Cookie para as próximas requisições. */
export async function login(app: FastifyInstance, senha = SENHA): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    payload: `senha=${encodeURIComponent(senha)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const c = res.cookies.find((x) => x.name === 'sessao');
  if (!c) throw new Error('login não devolveu cookie');
  return `sessao=${c.value}`;
}

export const form = (cookie: string, body: Record<string, string>) => ({
  payload: new URLSearchParams(body).toString(),
  headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/x-www-form-urlencoded' },
});

export const pedidoPadrao = {
  quantidade: 1,
  modo: 'troca' as const,
  pagamento: 'dinheiro' as const,
  trocoParaCentavos: 20000,
  endereco: { rua: 'Rua das Flores', numero: '120', bairro: 'Centro' },
};
