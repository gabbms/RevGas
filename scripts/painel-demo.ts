/**
 * Painel de demonstração, com dados de exemplo e WhatsApp falso. Não toca no banco real nem envia nada.
 * Uso: npx tsx scripts/painel-demo.ts
 *   http://localhost:3100  painel normal (senha: demo-painel-123)
 *   http://localhost:3101  o mesmo painel já logado (para capturas de tela e inspeção)
 */
import { rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createAlertService } from '../src/alerts/service.js';
import { loadEnv } from '../src/config/env.js';
import { openDb } from '../src/db/connection.js';
import { quote } from '../src/domain/pricing.js';
import type { Address, CylinderMode, OrderStatus, PaymentMethod } from '../src/domain/types.js';
import { createWhatsAppDispatcher } from '../src/orders/dispatcher.js';
import { createOrderService } from '../src/orders/service.js';
import { registerPanel } from '../src/panel/auth.js';
import { buildApp } from '../src/server.js';
import { insertAlert } from '../src/store/alerts.js';
import { updateCustomer, upsertCustomerByPhone } from '../src/store/customers.js';
import { insertMessage } from '../src/store/messages.js';
import { insertOrder } from '../src/store/orders.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../src/store/settings.js';
import { createOutbox } from '../src/whatsapp/outbox.js';
import { FakeWhatsApp } from '../tests/fakes/fake-whatsapp.js';

const PORTA = 3100;
const PORTA_LOGADO = 3101;
const SENHA = 'demo-painel-123';
const DB_PATH = '.taste-skill/demo/painel-demo.db';

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) rmSync(f, { force: true });

const env = loadEnv({
  DB_PATH,
  PUBLIC_URL: `http://localhost:${PORTA}`,
  WA_TOKEN: 'demo',
  WA_PHONE_NUMBER_ID: 'demo',
  WA_APP_SECRET: 'demo',
  WA_VERIFY_TOKEN: 'demo',
  WA_TPL_PEDIDO: 'pedido_novo',
  WA_TPL_ALERTA: 'alerta_dono',
  ANTHROPIC_API_KEY: 'demo',
  OPENAI_API_KEY: 'demo',
  PANEL_PASSWORD: SENHA,
  SESSION_SECRET: 'demo'.repeat(10),
});

const db = openDb(DB_PATH);
const RAIMUNDO = '5586994410021';
const CHICO = '5586995520387';
updateSettings(db, {
  ...DEFAULT_SETTINGS,
  nomeLoja: 'Revenda Gás',
  enderecoLoja: 'Rua Desembargador Pires de Castro, 1120, Centro, Teresina',
  precoRecargaCentavos: 12000,
  precoCompletoCentavos: 31000,
  previsaoEntregaMin: 40,
  horarios: {
    dom: { abre: '08:00', fecha: '12:00' },
    seg: { abre: '07:00', fecha: '19:00' },
    ter: { abre: '07:00', fecha: '19:00' },
    qua: { abre: '07:00', fecha: '19:00' },
    qui: { abre: '07:00', fecha: '19:00' },
    sex: { abre: '07:00', fecha: '19:00' },
    sab: { abre: '07:00', fecha: '17:00' },
  },
  bairros: ['Nossa Senhora das Graças', 'Morada do Sol', 'Castelo Branco', 'Fátima', 'Jóquei', 'Ininga'],
  pagamentos: ['dinheiro', 'cartao', 'pix_entrega', 'pix_antecipado', 'gas_do_povo'],
  chavePix: 'CNPJ 12.345.678/0001-90',
  telefoneDono: '5586999990000',
  entregadores: [
    { nome: 'Raimundo', telefone: RAIMUNDO },
    { nome: 'Chico', telefone: CHICO },
  ],
  destinoPedidos: 'entregadores',
  gasDoPovo: { aceita: true, modalidade: 'entrega', taxaEntregaCentavos: 500 },
  lembretesAtivos: true,
  fuso: 'America/Fortaleza',
});
const settings = () => getSettings(db);

const agora = Date.now();
const min = (m: number) => new Date(agora - m * 60_000);
const dias = (d: number) => new Date(agora - d * 24 * 60 * 60_000);

const end = (rua: string, numero: string, bairro: string, extra: Partial<Address> = {}): Address => ({ rua, numero, bairro, ...extra });

const clientes = [
  { tel: '5586988120455', nome: 'Maria das Graças Sousa', e: end('Rua Arlindo Nogueira', '1543', 'Nossa Senhora das Graças') },
  { tel: '5586999437781', nome: 'José Ribamar Carvalho', e: end('Rua Anísio de Abreu', '220', 'Morada do Sol', { complemento: 'casa B' }) },
  { tel: '5586994002316', nome: 'Francisca Lima', e: end('Avenida Kennedy', '3180', 'Castelo Branco', { referencia: 'perto da farmácia' }) },
  { tel: '5586988751209', nome: 'Antônio Carlos Meneses', e: end('Rua Áurea Freire', '87', 'Jóquei') },
  { tel: '5586999810344', nome: 'Ana Cláudia Rocha', e: end('Rua Angélica', '1090', 'Fátima') },
  { tel: '5586994536620', nome: 'Raimunda Nonata', e: end('Rua Gabriel Ferreira', '45', 'Nossa Senhora das Graças') },
  { tel: '5586988093371', nome: 'Pedro Henrique Lustosa', e: end('Avenida Universitária', '760', 'Ininga', { complemento: 'apto 302' }) },
  { tel: '5586999275018', nome: 'Luana Barros', e: end('Rua Coelho Rodrigues', '2011', 'Morada do Sol') },
  { tel: '5586994861452', nome: 'Sebastião Araújo', e: end('Rua São Pedro', '330', 'Castelo Branco') },
  { tel: '5586988664097', nome: null, e: null },
].map((c, i) => {
  const base = upsertCustomerByPhone(db, c.tel, dias(60 - i * 4));
  return updateCustomer(db, base.id, { nome: c.nome, endereco: c.e });
});
const [maria, jose, francisca, antonio, ana, raimunda, pedro, luana, sebastiao, semNome] = clientes as [
  (typeof clientes)[number], (typeof clientes)[number], (typeof clientes)[number], (typeof clientes)[number],
  (typeof clientes)[number], (typeof clientes)[number], (typeof clientes)[number], (typeof clientes)[number],
  (typeof clientes)[number], (typeof clientes)[number],
];

type PedidoDemo = {
  c: (typeof clientes)[number];
  q?: number;
  modo?: CylinderMode;
  pag: PaymentMethod;
  troco?: number;
  retirada?: boolean;
  status: OrderStatus;
  criado: Date;
  saiu?: Date;
  fim?: Date;
  entregador?: string;
};

function pedido(p: PedidoDemo) {
  const q = p.q ?? 1;
  const modo = p.modo ?? 'troca';
  const qt = quote(settings(), { quantidade: q, modo, pagamento: p.pag });
  const enviado = p.status !== 'agendado';
  return insertOrder(db, {
    clienteId: p.c.id,
    tipo: p.retirada ? 'retirada' : 'entrega',
    quantidade: q,
    modo,
    pagamento: p.pag,
    trocoParaCentavos: p.pag === 'dinheiro' ? (p.troco ?? null) : null,
    endereco: p.retirada ? null : p.c.endereco,
    ...qt,
    status: p.status,
    entregadorTelefone: p.entregador ?? null,
    precisaRevisao: q >= 3,
    criadoEm: p.criado.toISOString(),
    enviadoEm: enviado ? p.criado.toISOString() : null,
    saiuEm: p.saiu?.toISOString() ?? null,
    finalizadoEm: p.fim?.toISOString() ?? null,
  });
}

// Histórico (pedidos entregues em dias anteriores: alimentam a próxima recompra).
for (const [c, d] of [[maria, 34], [maria, 68], [jose, 29], [francisca, 41], [antonio, 25], [ana, 38], [luana, 31], [sebastiao, 45]] as const) {
  pedido({ c, pag: 'dinheiro', status: 'entregue', criado: dias(d), saiu: dias(d), fim: dias(d), entregador: RAIMUNDO });
}

// Hoje.
pedido({ c: pedro, pag: 'cartao', status: 'entregue', criado: min(250), saiu: min(235), fim: min(205), entregador: CHICO });
pedido({ c: raimunda, pag: 'gas_do_povo', status: 'entregue', criado: min(200), saiu: min(180), fim: min(150), entregador: RAIMUNDO });
pedido({ c: sebastiao, pag: 'dinheiro', retirada: true, status: 'retirado', criado: min(170), fim: min(150) });
pedido({ c: ana, pag: 'pix_entrega', status: 'cancelado', criado: min(140), fim: min(130) });
pedido({ c: antonio, q: 3, pag: 'pix_antecipado', status: 'entregue', criado: min(120), saiu: min(100), fim: min(70), entregador: CHICO });
pedido({ c: luana, modo: 'completo', pag: 'cartao', status: 'saiu', criado: min(48), saiu: min(30), entregador: RAIMUNDO });
pedido({ c: francisca, pag: 'dinheiro', troco: 20000, status: 'recebido', criado: min(22) });
pedido({ c: jose, pag: 'pix_antecipado', status: 'recebido', criado: min(9) });
pedido({ c: maria, pag: 'dinheiro', troco: 15000, status: 'recebido', criado: min(4) });
pedido({ c: semNome, pag: 'pix_entrega', status: 'agendado', criado: dias(0.5) });

// Conversas.
const msg = (c: (typeof clientes)[number], autor: 'cliente' | 'bot' | 'dono', texto: string, quando: Date, tipo: 'texto' | 'audio' = 'texto') =>
  insertMessage(db, { clienteId: c.id, autor, tipo, texto, wamid: null, criadoEm: quando.toISOString() });

msg(maria, 'cliente', 'Bom dia! Quero um gás, o de sempre', min(6));
msg(maria, 'bot', 'Bom dia, Maria! 1 botijão P13 (troca) para a Rua Arlindo Nogueira, 1543, Nossa Senhora das Graças. Pagamento em dinheiro. Total R$ 120,00. Confirma?', min(6));
msg(maria, 'cliente', 'Confirmo. Troco pra 150', min(5));
msg(maria, 'bot', 'Pedido #17 confirmado! Levo troco para R$ 150,00. Chega em uns 40 minutos.', min(4));

msg(jose, 'cliente', 'quero um gás pagando no pix', min(11), 'audio');
msg(jose, 'bot', 'Certo, José! 1 botijão P13 (troca), total R$ 120,00. Chave Pix: CNPJ 12.345.678/0001-90. Pode mandar o comprovante aqui. Confirma?', min(11));
msg(jose, 'cliente', 'confirmo, já paguei', min(10));
msg(jose, 'cliente', '[imagem]', min(10));
msg(jose, 'bot', 'Recebi o comprovante e repassei ao entregador. Pedido #16, chega em uns 40 minutos.', min(9));

msg(francisca, 'cliente', 'Oi, o gás de ontem veio vazando, quero falar com alguém', min(26));
msg(francisca, 'bot', 'Sinto muito, Francisca! Já chamei o responsável, ele te responde por aqui.', min(26));
msg(francisca, 'dono', 'Oi Francisca, aqui é o dono. Já vou mandar o Raimundo trocar o botijão sem custo.', min(24));
msg(francisca, 'cliente', 'Obrigada! Aproveita e manda mais um, pago em dinheiro, troco pra 200', min(23));
updateCustomer(db, francisca.id, { botPausadoAte: new Date(agora + 96 * 60_000).toISOString() });

msg(luana, 'cliente', 'Preciso de um botijão completo, não tenho o casco', min(50));
msg(luana, 'bot', 'Sem problema, Luana! 1 botijão P13 completo (com casco): R$ 310,00, no cartão na entrega. Confirma?', min(50));
msg(luana, 'cliente', 'sim', min(49));
msg(luana, 'bot', 'Pedido #15 confirmado! O Raimundo já saiu com ele.', min(30));

msg(ana, 'cliente', 'Pode cancelar, meu marido já comprou', min(131));
msg(ana, 'bot', 'Pronto, Ana, pedido #13 cancelado. Quando precisar é só chamar!', min(130));

msg(semNome, 'cliente', 'Vocês entregam amanhã cedo?', dias(0.5));
msg(semNome, 'bot', 'Entregamos sim! Abrimos às 07:00. Já deixei seu pedido agendado para a abertura.', dias(0.5));

// Alertas abertos.
insertAlert(db, { clienteId: francisca.id, pedidoId: null, motivo: 'Cliente pediu para falar com uma pessoa', resumo: 'Botijão de ontem veio vazando. Quer troca.' }, min(26));
insertAlert(db, { clienteId: jose.id, pedidoId: null, motivo: 'Comprovante Pix para conferir', resumo: 'Pedido #16, R$ 120,00 no Pix antecipado. Confira no banco antes da entrega.' }, min(9));

// App.
const fake = new FakeWhatsApp();
const clock = () => new Date();
const outbox = createOutbox(db, fake, clock);
for (const c of clientes) outbox.registerInbound(c.telefone, min(10));
const alerts = createAlertService({ db, outbox, settings, publicUrl: env.PUBLIC_URL, clock });
const dispatcher = createWhatsAppDispatcher({ db, outbox, settings });
const orders = createOrderService({ db, dispatcher, alerts, outbox, settings, clock });
const app = await buildApp({
  env,
  onInbound: async () => {},
  registerPanel: (a) => registerPanel(a, { db, env, orders, alerts, outbox, settings, clock }),
});
await app.listen({ port: PORTA, host: '127.0.0.1' });

// Proxy já logado: entra com a senha e repassa o cookie em toda requisição.
const login = await app.inject({
  method: 'POST',
  url: '/login',
  payload: `senha=${encodeURIComponent(SENHA)}`,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});
const sessao = login.cookies.find((c) => c.name === 'sessao');
if (!sessao) throw new Error('login da demonstração falhou');
const cookie = `sessao=${sessao.value}`;

createServer((req, res) => {
  const up = request(
    { host: '127.0.0.1', port: PORTA, path: req.url, method: req.method, headers: { ...req.headers, cookie } },
    (r) => {
      // Redireciona para o próprio proxy, não para a porta de origem.
      const headers = { ...r.headers };
      if (typeof headers.location === 'string') headers.location = headers.location.replace(`http://localhost:${PORTA}`, '');
      res.writeHead(r.statusCode ?? 502, headers);
      r.pipe(res);
    },
  );
  req.pipe(up);
}).listen(PORTA_LOGADO, '127.0.0.1');

console.log(`painel de demonstração: http://localhost:${PORTA} (senha ${SENHA})`);
console.log(`já logado: http://localhost:${PORTA_LOGADO}/painel/pedidos`);
