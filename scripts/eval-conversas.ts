/**
 * Roteiro de conversas com o Claude REAL (custa centavos com o Haiku).
 * Uso: ANTHROPIC_API_KEY=... npx tsx scripts/eval-conversas.ts
 * Banco :memory:, WhatsApp falso, relógio fixo numa segunda às 10h (America/Sao_Paulo).
 */
import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from '../src/config/env.js';
import { createAppContext, type AppContext } from '../src/main.js';
import { listOpenAlerts } from '../src/store/alerts.js';
import { updateCustomer, upsertCustomerByPhone } from '../src/store/customers.js';
import { insertOrder, listOrdersByCustomer } from '../src/store/orders.js';
import { DEFAULT_SETTINGS, updateSettings, type StoreSettings } from '../src/store/settings.js';
import { FakeWhatsApp } from '../tests/fakes/fake-whatsapp.js';

const SEGUNDA_10H = new Date('2026-11-02T13:00:00Z');
const PRECO = 11500;
const DONO = '5586999990000';
const ENDERECO = { rua: 'Rua das Flores', numero: '120', bairro: 'Centro' };

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Defina ANTHROPIC_API_KEY para rodar o roteiro.');
  process.exit(2);
}

const env = loadEnv({
  DB_PATH: ':memory:',
  PUBLIC_URL: 'https://loja.exemplo',
  WA_TOKEN: 'x',
  WA_PHONE_NUMBER_ID: '1',
  WA_APP_SECRET: 'x',
  WA_VERIFY_TOKEN: 'x',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ...(process.env.AI_MODEL ? { AI_MODEL: process.env.AI_MODEL } : {}),
  OPENAI_API_KEY: 'x',
  PANEL_PASSWORD: 'x',
  SESSION_SECRET: 'x'.repeat(32),
});

interface Scenario {
  ctx: AppContext;
  fake: FakeWhatsApp;
  phone: string;
  clienteId: number;
  /** JSON de tudo que foi enviado ao modelo, turno a turno. */
  modelInputs: string[];
  /** Respostas do bot ao cliente, em ordem. */
  replies(): string[];
  say(text: string): Promise<string | undefined>;
  clock: { now: Date };
}

async function setup(phone: string, settings: Partial<StoreSettings>): Promise<Scenario> {
  const clock = { now: SEGUNDA_10H };
  const fake = new FakeWhatsApp();
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 2 });
  const modelInputs: string[] = [];
  const original = anthropic.beta.messages.toolRunner.bind(anthropic.beta.messages);
  (anthropic.beta.messages as { toolRunner: unknown }).toolRunner = (params: { messages: unknown }, opts?: never) => {
    modelInputs.push(JSON.stringify(params.messages));
    return (original as (p: unknown, o?: unknown) => unknown)(params, opts);
  };
  const ctx = await createAppContext(env, { api: fake, anthropic, clock: () => clock.now });
  updateSettings(ctx.db, {
    ...DEFAULT_SETTINGS,
    bairros: ['Centro'],
    pagamentos: ['dinheiro', 'cartao', 'pix_entrega'],
    telefoneDono: DONO,
    ...settings,
  });
  const cliente = upsertCustomerByPhone(ctx.db, phone, clock.now);
  let n = 0;
  return {
    ctx,
    fake,
    phone,
    clienteId: cliente.id,
    modelInputs,
    clock,
    replies: () => fake.sent.flatMap((m) => (m.to === phone && m.kind === 'text' ? [m.body] : [])),
    async say(text) {
      clock.now = new Date(clock.now.getTime() + 20_000);
      const before = fake.sent.length;
      await ctx.router.handle([{ wamid: `wamid.eval.${phone}.${++n}`, de: phone, nomePerfil: undefined, em: clock.now, conteudo: { tipo: 'texto', texto: text } } as never]);
      await ctx.router.idle();
      const novos = fake.sent.slice(before).flatMap((m) => (m.to === phone && m.kind === 'text' ? [m.body] : []));
      return novos.at(-1);
    },
  };
}

function printConversation(s: Scenario): void {
  const rows = s.ctx.db
    .prepare('SELECT autor, texto FROM messages WHERE cliente_id = ? ORDER BY id')
    .all(s.clienteId) as { autor: string; texto: string }[];
  for (const r of rows) console.log(`  ${r.autor === 'cliente' ? 'CLIENTE' : 'BOT    '}: ${r.texto.replaceAll('\n', '\n           ')}`);
}

type Check = [label: string, ok: boolean];
let failures = 0;

function report(nome: string, s: Scenario, checks: Check[]): void {
  console.log(`\n=== ${nome} ===`);
  printConversation(s);
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}: ${label}`);
    if (!ok) failures++;
  }
}

const hasReais = (t: string): boolean => /R\$\s*\d/.test(t);

async function cenario1(): Promise<void> {
  const s = await setup('5586988880001', { precoRecargaCentavos: PRECO, precoCompletoCentavos: 32000 });
  await s.say('manda um gás');
  await s.say('Sou o Carlos. Rua das Palmeiras, 45, casa azul, Centro. Tenho o botijão vazio pra trocar.');
  await s.say('Vou pagar em dinheiro, preciso de troco pra 200');
  for (const confirm of ['sim, pode confirmar', 'sim', 'isso, confirma']) {
    if (listOrdersByCustomer(s.ctx.db, s.clienteId).length > 0) break;
    await s.say(confirm);
  }
  const orders = listOrdersByCustomer(s.ctx.db, s.clienteId);
  report('1. Cliente novo pede um gás, paga em dinheiro com troco', s, [
    ['exatamente 1 pedido criado', orders.length === 1],
    [`total = preço configurado (${PRECO})`, orders[0]?.totalCentavos === PRECO],
    ['troco para 20000', orders[0]?.trocoParaCentavos === 20000],
  ]);
}

async function cenario2(): Promise<void> {
  const s = await setup('5586988880002', { precoRecargaCentavos: PRECO, precoCompletoCentavos: 32000 });
  updateCustomer(s.ctx.db, s.clienteId, { nome: 'Maria', endereco: ENDERECO });
  insertOrder(s.ctx.db, {
    clienteId: s.clienteId, tipo: 'entrega', quantidade: 1, modo: 'troca', pagamento: 'dinheiro', trocoParaCentavos: null,
    endereco: ENDERECO, unitarioCentavos: PRECO, cascoCentavos: 0, taxaEntregaCentavos: 0, totalCentavos: PRECO,
    status: 'entregue', entregadorTelefone: null, precisaRevisao: false,
    criadoEm: '2026-10-05T13:00:00Z', enviadoEm: '2026-10-05T13:00:00Z', saiuEm: null, finalizadoEm: '2026-10-05T14:00:00Z',
  });
  const reply = await s.say('o de sempre');
  report('2. Cliente antigo pede "o de sempre"', s, [
    ['o resumo usa o endereço salvo (Rua das Flores, 120)', !!reply && reply.includes('Rua das Flores') && reply.includes('120')],
  ]);
}

async function cenario3(): Promise<void> {
  const s = await setup('5586988880003', { precoRecargaCentavos: 0, precoCompletoCentavos: 0 });
  const reply = await s.say('quanto tá o gás?');
  const alertas = listOpenAlerts(s.ctx.db);
  report('3. Preço não cadastrado', s, [
    ['nenhum valor em R$ inventado na resposta', !!reply && !hasReais(reply)],
    ['1 alerta criado', alertas.length === 1],
  ]);
}

async function cenario4(): Promise<void> {
  const s = await setup('5586988880004', { precoRecargaCentavos: PRECO, precoCompletoCentavos: 32000 });
  await s.say('quero um gás pra Rua do Sol, 300, bairro Planalto. Sou a Ana, pago em dinheiro sem troco.');
  await s.say('sim, pode confirmar');
  await s.say('confirma por favor');
  report('4. Bairro fora da área', s, [['nenhum pedido criado', listOrdersByCustomer(s.ctx.db, s.clienteId).length === 0]]);
}

async function cenario5(): Promise<void> {
  const s = await setup('5586988880005', {
    precoRecargaCentavos: PRECO,
    precoCompletoCentavos: 32000,
    pagamentos: ['dinheiro', 'cartao', 'pix_entrega', 'gas_do_povo'],
    gasDoPovo: { aceita: true, modalidade: 'entrega', taxaEntregaCentavos: 0 },
  });
  updateCustomer(s.ctx.db, s.clienteId, { nome: 'Dona Rita', endereco: ENDERECO });
  insertOrder(s.ctx.db, {
    clienteId: s.clienteId, tipo: 'entrega', quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo', trocoParaCentavos: null,
    endereco: ENDERECO, unitarioCentavos: 0, cascoCentavos: 0, taxaEntregaCentavos: 0, totalCentavos: 0,
    status: 'recebido', entregadorTelefone: null, precisaRevisao: false,
    criadoEm: SEGUNDA_10H.toISOString(), enviadoEm: SEGUNDA_10H.toISOString(), saiuEm: null, finalizadoEm: null,
  });
  const reply = await s.say('482913');
  const gravadas = (s.ctx.db.prepare('SELECT texto FROM messages WHERE cliente_id = ?').all(s.clienteId) as { texto: string }[]).map((m) => m.texto);
  report('5. Gás do Povo: cliente manda o código', s, [
    ['o código não foi gravado nas mensagens', !gravadas.some((t) => t.includes('482913'))],
    ['o modelo nunca recebeu o código', s.modelInputs.length > 0 && !s.modelInputs.some((m) => m.includes('482913'))],
    ['a resposta orienta a mostrar o código ao entregador', !!reply && /entregador/i.test(reply)],
  ]);
}

async function cenario6(): Promise<void> {
  const s = await setup('5586988880006', { precoRecargaCentavos: PRECO, precoCompletoCentavos: 32000 });
  updateCustomer(s.ctx.db, s.clienteId, { nome: 'Seu Jorge', endereco: ENDERECO });
  insertOrder(s.ctx.db, {
    clienteId: s.clienteId, tipo: 'entrega', quantidade: 1, modo: 'troca', pagamento: 'dinheiro', trocoParaCentavos: null,
    endereco: ENDERECO, unitarioCentavos: PRECO, cascoCentavos: 0, taxaEntregaCentavos: 0, totalCentavos: PRECO,
    status: 'recebido', entregadorTelefone: null, precisaRevisao: false,
    criadoEm: '2026-11-02T11:00:00Z', enviadoEm: '2026-11-02T11:00:00Z', saiuEm: null, finalizadoEm: null,
  });
  const r1 = await s.say('Pedi meu gás tem mais de 2 horas e nada de chegar, isso é um absurdo!');
  const r2 = await s.say('e aí, vão mandar ou não?');
  report('6. Reclamação de atraso', s, [
    ['alerta criado para o dono', listOpenAlerts(s.ctx.db).length >= 1],
    ['o bot respondeu à reclamação', !!r1],
    ['o bot continua respondendo', !!r2],
  ]);
}

const cenarios = [cenario1, cenario2, cenario3, cenario4, cenario5, cenario6];
console.log(`Modelo: ${env.AI_MODEL} (esforço ${env.AI_EFFORT})`);
for (const run of cenarios) {
  try {
    await run();
  } catch (err) {
    failures++;
    console.log(`
FALHOU: ${run.name} lançou ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`
${failures === 0 ? 'Todos os cenários PASSARAM.' : `${failures} verificação(ões) FALHARAM.`}`);
process.exit(failures === 0 ? 0 : 1);
