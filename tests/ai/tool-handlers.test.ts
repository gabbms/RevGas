import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { createOutbox } from '../../src/whatsapp/outbox.js';
import { createAlertService } from '../../src/alerts/service.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings, type StoreSettings } from '../../src/store/settings.js';
import { getCustomer, upsertCustomerByPhone, updateCustomer } from '../../src/store/customers.js';
import { getDraft } from '../../src/store/drafts.js';
import { getOrder, lastOrderFor, updateOrder } from '../../src/store/orders.js';
import { listOpenAlerts } from '../../src/store/alerts.js';
import { createWhatsAppDispatcher } from '../../src/orders/dispatcher.js';
import { createOrderService } from '../../src/orders/service.js';
import { createToolHandlers, type ToolContext } from '../../src/ai/tool-handlers.js';
import { buildTools } from '../../src/ai/tools.js';
import type { Address } from '../../src/domain/types.js';
import { FakeWhatsApp } from '../fakes/fake-whatsapp.js';

const SEGUNDA_10H = new Date('2026-11-02T13:00:00Z');
const SEGUNDA_10H_05 = new Date('2026-11-02T13:00:05Z');
const SEGUNDA_10H_01 = new Date('2026-11-02T13:01:00Z');
const DOMINGO_21H30 = new Date('2026-11-02T00:30:00Z');

const DONO = '5586999990000';
const JOAO = '5586911110000';
const CLIENTE = '5586988887777';
const OUTRO = '5586977776666';

const base: StoreSettings = {
  ...DEFAULT_SETTINGS,
  nomeLoja: 'Gás Bom',
  enderecoLoja: 'Av. Central, 10',
  precoRecargaCentavos: 11500,
  precoCompletoCentavos: 32000,
  bairros: ['Centro'],
  pagamentos: ['dinheiro', 'cartao', 'pix_entrega', 'pix_antecipado', 'gas_do_povo'],
  chavePix: 'cnpj 00.000.000/0001-00',
  telefoneDono: DONO,
  entregadores: [{ nome: 'João', telefone: JOAO }],
  destinoPedidos: 'entregadores',
  gasDoPovo: { aceita: true, modalidade: 'entrega', taxaEntregaCentavos: 500 },
};

const end: Address = { rua: 'Rua das Flores', numero: '120', bairro: 'Centro' };

function setup(over: Partial<StoreSettings> = {}, at: Date = SEGUNDA_10H) {
  let t = at;
  const clock = () => t;
  const db = openDb(':memory:');
  const fake = new FakeWhatsApp();
  const outbox = createOutbox(db, fake, clock);
  updateSettings(db, { ...base, ...over });
  const settings = () => getSettings(db);
  const cliente = updateCustomer(db, upsertCustomerByPhone(db, CLIENTE, t).id, { nome: 'Maria' });
  const outro = upsertCustomerByPhone(db, OUTRO, t);
  for (const p of [DONO, JOAO, CLIENTE, OUTRO]) outbox.registerInbound(p, t);
  const alerts = createAlertService({ db, outbox, settings, publicUrl: 'https://loja.exemplo', clock });
  const dispatcher = createWhatsAppDispatcher({ db, outbox, settings });
  const orders = createOrderService({ db, dispatcher, alerts, outbox, settings, clock });
  const ctx: ToolContext = {
    db,
    clienteId: cliente.id,
    settings,
    orders,
    alerts,
    clock,
    ultimaMensagemClienteEm: at,
  };
  const setTime = (d: Date) => {
    t = d;
  };
  return { db, fake, ctx, cliente, outro, orders, setTime };
}

/** Prepara um rascunho num turno e confirma no turno seguinte. */
async function pedidoConfirmado(s: ReturnType<typeof setup>, req: Parameters<ReturnType<typeof createToolHandlers>['prepararPedido']>[0]) {
  s.setTime(SEGUNDA_10H_05);
  const p = await createToolHandlers(s.ctx).prepararPedido(req);
  if (!('rascunhoId' in p)) throw new Error(p.erros.join('; '));
  s.setTime(SEGUNDA_10H_01);
  const r = await createToolHandlers({ ...s.ctx, ultimaMensagemClienteEm: SEGUNDA_10H_01 }).confirmarPedido({
    rascunhoId: p.rascunhoId,
  });
  if (!('numero' in r)) throw new Error(JSON.stringify(r));
  return r;
}

describe('confirmarPedido', () => {
  test('confirmar no mesmo turno do resumo é recusado', async () => {
    const s = setup();
    s.setTime(SEGUNDA_10H_05);
    const h = createToolHandlers({ ...s.ctx, ultimaMensagemClienteEm: SEGUNDA_10H });
    const p = await h.prepararPedido({ quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end });
    if (!('rascunhoId' in p)) throw new Error('rascunho inválido');
    expect(await h.confirmarPedido({ rascunhoId: p.rascunhoId })).toMatchObject({
      erro: expect.stringContaining('espere o cliente'),
    });
    expect(getOrder(s.db, 1)).toBeNull();
    expect(getDraft(s.db, p.rascunhoId)?.consumidoEm).toBeNull();
  });

  test('rascunho criado no mesmo instante da última mensagem também é recusado', async () => {
    const s = setup();
    s.setTime(SEGUNDA_10H_05);
    const h = createToolHandlers({ ...s.ctx, ultimaMensagemClienteEm: SEGUNDA_10H_05 });
    const p = await h.prepararPedido({ quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end });
    if (!('rascunhoId' in p)) throw new Error('rascunho inválido');
    expect(await h.confirmarPedido({ rascunhoId: p.rascunhoId })).toEqual({
      erro: 'mostre o resumo e espere o cliente confirmar',
    });
  });

  test('confirmar no turno seguinte cria pedido', async () => {
    const s = setup();
    s.setTime(SEGUNDA_10H_05);
    const p = await createToolHandlers(s.ctx).prepararPedido({
      quantidade: 1,
      modo: 'troca',
      pagamento: 'cartao',
      endereco: end,
    });
    if (!('rascunhoId' in p)) throw new Error('rascunho inválido');
    s.setTime(SEGUNDA_10H_01);
    const h2 = createToolHandlers({ ...s.ctx, ultimaMensagemClienteEm: SEGUNDA_10H_01 });
    const r = await h2.confirmarPedido({ rascunhoId: p.rascunhoId });
    expect(r).toEqual({ numero: 1, status: 'recebido', tipo: 'entrega', previsaoEntregaMin: 40, agendado: false });
    expect(getDraft(s.db, p.rascunhoId)?.consumidoEm).not.toBeNull();
    // Cliente sem endereço passa a ter o do pedido.
    expect(getCustomer(s.db, s.cliente.id)?.endereco).toEqual(end);
    // Um segundo "sim" não cria outro pedido.
    expect(await h2.confirmarPedido({ rascunhoId: p.rascunhoId })).toMatchObject({ erro: expect.any(String) });
    expect(getOrder(s.db, 2)).toBeNull();
  });

  test('não sobrescreve o endereço já salvo do cliente', async () => {
    const s = setup();
    const salvo: Address = { rua: 'Rua A', numero: '1', bairro: 'Centro' };
    updateCustomer(s.db, s.cliente.id, { endereco: salvo });
    await pedidoConfirmado(s, { quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end });
    expect(getCustomer(s.db, s.cliente.id)?.endereco).toEqual(salvo);
  });

  test('preço mudou entre resumo e sim', async () => {
    const s = setup();
    s.setTime(SEGUNDA_10H_05);
    const p = await createToolHandlers(s.ctx).prepararPedido({
      quantidade: 1,
      modo: 'troca',
      pagamento: 'cartao',
      endereco: end,
    });
    if (!('rascunhoId' in p)) throw new Error('rascunho inválido');
    expect(p.total).toBe('R$ 115,00');
    updateSettings(s.db, { ...getSettings(s.db), precoRecargaCentavos: 12000 });
    s.setTime(SEGUNDA_10H_01);
    const r = await createToolHandlers({ ...s.ctx, ultimaMensagemClienteEm: SEGUNDA_10H_01 }).confirmarPedido({
      rascunhoId: p.rascunhoId,
    });
    expect(r).toMatchObject({ erro: 'preco_mudou', novoRascunho: { total: 'R$ 120,00' } });
    expect(getOrder(s.db, 1)).toBeNull();
  });

  test('rascunho de outro cliente é recusado', async () => {
    const s = setup();
    s.setTime(SEGUNDA_10H_05);
    const p = await createToolHandlers({ ...s.ctx, clienteId: s.outro.id }).prepararPedido({
      quantidade: 1,
      modo: 'troca',
      pagamento: 'cartao',
      endereco: end,
    });
    if (!('rascunhoId' in p)) throw new Error('rascunho inválido');
    s.setTime(SEGUNDA_10H_01);
    const r = await createToolHandlers({ ...s.ctx, ultimaMensagemClienteEm: SEGUNDA_10H_01 }).confirmarPedido({
      rascunhoId: p.rascunhoId,
    });
    expect(r).toMatchObject({ erro: expect.any(String) });
    expect(getOrder(s.db, 1)).toBeNull();
  });

  test('rascunho com mais de 2h é recusado', async () => {
    const s = setup();
    s.setTime(SEGUNDA_10H_05);
    const p = await createToolHandlers(s.ctx).prepararPedido({
      quantidade: 1,
      modo: 'troca',
      pagamento: 'cartao',
      endereco: end,
    });
    if (!('rascunhoId' in p)) throw new Error('rascunho inválido');
    const tarde = new Date(SEGUNDA_10H_05.getTime() + 2 * 60 * 60 * 1000 + 1000);
    s.setTime(tarde);
    const r = await createToolHandlers({ ...s.ctx, ultimaMensagemClienteEm: tarde }).confirmarPedido({
      rascunhoId: p.rascunhoId,
    });
    expect(r).toMatchObject({ erro: expect.stringContaining('expirou') });
    expect(getOrder(s.db, 1)).toBeNull();
  });

  test('erros do create são repassados e o rascunho não é consumido', async () => {
    const s = setup();
    s.setTime(SEGUNDA_10H_05);
    const p = await createToolHandlers(s.ctx).prepararPedido({
      quantidade: 1,
      modo: 'troca',
      pagamento: 'cartao',
      endereco: end,
    });
    if (!('rascunhoId' in p)) throw new Error('rascunho inválido');
    updateSettings(s.db, { ...getSettings(s.db), bairros: ['Fátima'] });
    s.setTime(SEGUNDA_10H_01);
    const r = await createToolHandlers({ ...s.ctx, ultimaMensagemClienteEm: SEGUNDA_10H_01 }).confirmarPedido({
      rascunhoId: p.rascunhoId,
    });
    expect(r).toMatchObject({ erros: [expect.stringContaining('Centro')] });
    expect(getDraft(s.db, p.rascunhoId)?.consumidoEm).toBeNull();
  });

  test('fora do horário o pedido fica agendado com a próxima abertura', async () => {
    const s = setup({}, DOMINGO_21H30);
    const h = createToolHandlers(s.ctx);
    const p = await h.prepararPedido({ quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end });
    expect(p).toMatchObject({ agendado: true, proximaAbertura: 'seg 02/11 07:00' });
    if (!('rascunhoId' in p)) throw new Error('rascunho inválido');
    const depois = new Date(DOMINGO_21H30.getTime() + 60_000);
    s.setTime(depois);
    const r = await createToolHandlers({ ...s.ctx, ultimaMensagemClienteEm: depois }).confirmarPedido({
      rascunhoId: p.rascunhoId,
    });
    expect(r).toEqual({
      numero: 1,
      status: 'agendado',
      tipo: 'entrega',
      previsaoEntregaMin: 40,
      agendado: true,
      proximaAbertura: 'seg 02/11 07:00',
    });
  });
});

describe('prepararPedido', () => {
  test('prepararPedido usa endereço salvo', async () => {
    const s = setup();
    updateCustomer(s.db, s.cliente.id, { endereco: { rua: 'Rua Salva', numero: '7', bairro: 'Centro' } });
    const p = await createToolHandlers(s.ctx).prepararPedido({ quantidade: 1, modo: 'troca', pagamento: 'cartao' });
    if (!('rascunhoId' in p)) throw new Error('rascunho inválido');
    expect(p.resumo.join('\n')).toContain('Rua Salva');
    expect(getDraft(s.db, p.rascunhoId)?.request.endereco?.rua).toBe('Rua Salva');
  });

  test('inválido devolve só os erros, sem rascunho', async () => {
    const s = setup();
    const p = await createToolHandlers(s.ctx).prepararPedido({ quantidade: 1, modo: 'troca', pagamento: 'cartao' });
    expect(p).toEqual({ erros: expect.arrayContaining([expect.stringContaining('rua')]) });
    expect(getDraft(s.db, 1)).toBeNull();
  });

  test('resumo traz troco e chave Pix', async () => {
    const s = setup();
    const h = createToolHandlers(s.ctx);
    const dinheiro = await h.prepararPedido({
      quantidade: 2,
      modo: 'troca',
      pagamento: 'dinheiro',
      trocoParaCentavos: 25000,
      endereco: end,
    });
    if (!('rascunhoId' in dinheiro)) throw new Error('rascunho inválido');
    expect(dinheiro.total).toBe('R$ 230,00');
    expect(dinheiro.resumo).toEqual(
      expect.arrayContaining([
        expect.stringContaining('2 botijões P13'),
        'Total: R$ 230,00',
        'Troco para R$ 250,00',
        expect.stringContaining('Rua das Flores, 120'),
      ]),
    );
    const pix = await h.prepararPedido({ quantidade: 1, modo: 'troca', pagamento: 'pix_antecipado', endereco: end });
    if (!('rascunhoId' in pix)) throw new Error('rascunho inválido');
    expect(pix.resumo).toContain('Chave Pix: cnpj 00.000.000/0001-00');
  });

  test('Gás do Povo completo mostra casco e taxa', async () => {
    const s = setup();
    const p = await createToolHandlers(s.ctx).prepararPedido({
      quantidade: 1,
      modo: 'completo',
      pagamento: 'gas_do_povo',
      endereco: end,
    });
    if (!('rascunhoId' in p)) throw new Error('rascunho inválido');
    expect(p.resumo).toEqual(
      expect.arrayContaining(['Casco: R$ 205,00 cada', 'Taxa de entrega: R$ 5,00', 'Total: R$ 210,00']),
    );
  });
});

describe('consultarLoja', () => {
  test('consultarLoja não inventa preço não cadastrado', async () => {
    const s = setup({ precoRecargaCentavos: 0 });
    const r = await createToolHandlers(s.ctx).consultarLoja();
    expect(r.precoRecarga).toBe('não cadastrado');
    expect(r.precoCompleto).toBe('R$ 320,00');
  });

  test('devolve dados formatados das configurações', async () => {
    const s = setup();
    const r = await createToolHandlers(s.ctx).consultarLoja();
    expect(r).toMatchObject({
      nomeLoja: 'Gás Bom',
      enderecoLoja: 'Av. Central, 10',
      agora: 'seg 02/11 10:00',
      abertaAgora: true,
      precoRecarga: 'R$ 115,00',
      previsaoEntregaMin: 40,
      bairros: ['Centro'],
      pagamentos: ['Dinheiro', 'Cartão (maquininha)', 'Pix na entrega', 'Pix antecipado', 'Gás do Povo'],
      chavePix: 'cnpj 00.000.000/0001-00',
      gasDoPovo: { aceita: true, modalidade: 'entrega', taxaEntrega: 'R$ 5,00' },
    });
    expect(r.proximaAbertura).toBeUndefined();
  });

  test('sem Pix antecipado não mostra a chave; fechada mostra próxima abertura', async () => {
    const s = setup({ pagamentos: ['dinheiro'] }, DOMINGO_21H30);
    const r = await createToolHandlers(s.ctx).consultarLoja();
    expect(r).not.toHaveProperty('chavePix');
    expect(r).toMatchObject({ abertaAgora: false, agora: 'dom 01/11 21:30', proximaAbertura: 'seg 02/11 07:00' });
  });
});

describe('consultarCliente e salvarCliente', () => {
  test('cliente novo', async () => {
    const s = setup();
    expect(await createToolHandlers(s.ctx).consultarCliente()).toEqual({
      nome: 'Maria',
      endereco: null,
      jaPediuAntes: false,
      pedidosEmAberto: [],
      lembretesDesativados: false,
    });
  });

  test('cliente com pedido mostra último pedido e pedidos em aberto', async () => {
    const s = setup();
    const r = await pedidoConfirmado(s, {
      quantidade: 2,
      modo: 'troca',
      pagamento: 'dinheiro',
      trocoParaCentavos: 30000,
      endereco: end,
    });
    const c = await createToolHandlers(s.ctx).consultarCliente();
    expect(c).toMatchObject({
      jaPediuAntes: true,
      endereco: end,
      ultimoPedido: { quantidade: 2, modo: 'troca', pagamento: 'dinheiro', trocoPara: 'R$ 300,00' },
      pedidosEmAberto: [
        { numero: r.numero, status: 'recebido', tipo: 'entrega', criadoEm: 'seg 02/11 10:01', previsaoEntregaMin: 40 },
      ],
    });
  });

  test('salvarCliente atualiza nome e endereço', async () => {
    const s = setup();
    expect(await createToolHandlers(s.ctx).salvarCliente({ nome: 'Maria José', endereco: end })).toEqual({ ok: true });
    expect(getCustomer(s.db, s.cliente.id)).toMatchObject({ nome: 'Maria José', endereco: end });
  });

  test('lastOrderFor ignora cancelados e devolve o mais recente', async () => {
    const s = setup();
    expect(lastOrderFor(s.db, s.cliente.id)).toBeNull();
    const a = await pedidoConfirmado(s, { quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end });
    const b = await pedidoConfirmado(s, { quantidade: 3, modo: 'troca', pagamento: 'cartao', endereco: end });
    updateOrder(s.db, b.numero, { status: 'cancelado' });
    expect(lastOrderFor(s.db, s.cliente.id)?.id).toBe(a.numero);
  });
});

describe('alterarPedido e cancelarPedido', () => {
  test('cancelar pedido de outro cliente é recusado', async () => {
    const s = setup();
    const r = await pedidoConfirmado(s, { quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end });
    const outro = createToolHandlers({ ...s.ctx, clienteId: s.outro.id });
    expect(await outro.cancelarPedido({ numero: r.numero })).toEqual({ ok: false, erro: 'pedido não encontrado' });
    expect(getOrder(s.db, r.numero)?.status).toBe('recebido');
    expect(await outro.alterarPedido({ numero: r.numero, mudancas: { quantidade: 2 } })).toEqual({
      ok: false,
      erro: 'pedido não encontrado',
    });
    expect(await outro.cancelarPedido({ numero: 999 })).toEqual({ ok: false, erro: 'pedido não encontrado' });
  });

  test('cancelar o próprio pedido', async () => {
    const s = setup();
    const r = await pedidoConfirmado(s, { quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end });
    expect(await createToolHandlers(s.ctx).cancelarPedido({ numero: r.numero })).toEqual({ ok: true });
    expect(getOrder(s.db, r.numero)?.status).toBe('cancelado');
  });

  test('alterar devolve resumo, erros ou motivo', async () => {
    const s = setup();
    const r = await pedidoConfirmado(s, { quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end });
    const h = createToolHandlers(s.ctx);
    const ok = await h.alterarPedido({ numero: r.numero, mudancas: { quantidade: 2 } });
    expect(ok).toMatchObject({ ok: true, resumo: expect.arrayContaining(['Total: R$ 230,00']) });
    const ruim = await h.alterarPedido({
      numero: r.numero,
      mudancas: { endereco: { rua: 'X', numero: '1', bairro: 'Longe' } },
    });
    expect(ruim).toMatchObject({ ok: false, erros: [expect.stringContaining('Longe')] });
    updateOrder(s.db, r.numero, { status: 'saiu' });
    expect(await h.alterarPedido({ numero: r.numero, mudancas: { quantidade: 3 } })).toEqual({
      ok: false,
      motivo: 'ja_saiu',
    });
  });
});

describe('alertarDono e desativarLembretes', () => {
  test('alertarDono cria alerta com o cliente', async () => {
    const s = setup();
    expect(await createToolHandlers(s.ctx).alertarDono({ motivo: 'Reclamação', resumo: 'Gás chegou tarde' })).toEqual({
      ok: true,
    });
    expect(listOpenAlerts(s.db)).toMatchObject([{ clienteId: s.cliente.id, motivo: 'Reclamação' }]);
  });

  test('desativarLembretes marca o cliente', async () => {
    const s = setup();
    expect(await createToolHandlers(s.ctx).desativarLembretes()).toEqual({ ok: true });
    expect(getCustomer(s.db, s.cliente.id)?.lembretesDesativados).toBe(true);
  });
});

describe('buildTools', () => {
  test('lista fixa de 9 ferramentas e run devolve JSON', async () => {
    const s = setup();
    const tools = buildTools(s.ctx);
    expect(tools.map((t) => t.name)).toEqual([
      'consultar_loja',
      'consultar_cliente',
      'salvar_cliente',
      'preparar_pedido',
      'confirmar_pedido',
      'alterar_pedido',
      'cancelar_pedido',
      'alertar_dono',
      'desativar_lembretes',
    ]);
    const out = await tools[0]!.run({});
    expect(typeof out).toBe('string');
    expect(JSON.parse(out as string)).toMatchObject({ nomeLoja: 'Gás Bom' });
  });
});
