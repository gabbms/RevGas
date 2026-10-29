import { describe, expect, test } from 'vitest';
import { normalizeText, validateOrderRequest } from '../../src/domain/order-validation.js';
import { DEFAULT_SETTINGS, type StoreSettings } from '../../src/store/settings.js';

const s = {
  ...DEFAULT_SETTINGS,
  precoRecargaCentavos: 11500,
  precoCompletoCentavos: 32000,
  bairros: ['Centro', 'Fátima'],
  pagamentos: ['dinheiro', 'cartao', 'pix_entrega', 'pix_antecipado', 'gas_do_povo'],
  chavePix: 'x',
  gasDoPovo: { aceita: true, modalidade: 'entrega', taxaEntregaCentavos: 500 },
} as StoreSettings;
const end = { rua: 'Rua A', numero: '10', bairro: 'fatima' };
const segunda10h = new Date('2026-11-02T13:00:00Z');
const base = { quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end } as const;
const erros = (r: ReturnType<typeof validateOrderRequest>): string[] => (r.ok ? [] : r.erros);

describe('normalizeText', () => {
  test('minúsculas, sem acento, espaços colapsados', () =>
    expect(normalizeText('  FÁTIMA   Ção ')).toBe('fatima cao'));
});

describe('validateOrderRequest', () => {
  test('bairro sem acento é aceito', () => {
    const r = validateOrderRequest(s, base, segunda10h);
    expect(r).toMatchObject({ ok: true, tipo: 'entrega', agendado: false, precisaRevisao: false });
  });
  test('bairro fora da área', () =>
    expect(validateOrderRequest(s, { ...base, endereco: { ...end, bairro: 'Dirceu' } }, segunda10h)).toMatchObject({ ok: false }));
  test('troco menor que total', () => {
    const r = validateOrderRequest(s, { ...base, pagamento: 'dinheiro', trocoParaCentavos: 10000 }, segunda10h);
    expect(r.ok).toBe(false);
    expect(erros(r)[0]).toContain('R$ 115,00');
  });
  test('dinheiro sem troco informado é válido; troco suficiente também', () => {
    expect(validateOrderRequest(s, { ...base, pagamento: 'dinheiro' }, segunda10h).ok).toBe(true);
    expect(validateOrderRequest(s, { ...base, pagamento: 'dinheiro', trocoParaCentavos: 11500 }, segunda10h).ok).toBe(true);
  });
  test('preço não configurado', () => {
    expect(validateOrderRequest({ ...s, precoRecargaCentavos: 0 }, base, segunda10h)).toMatchObject({ ok: false });
    expect(validateOrderRequest({ ...s, precoCompletoCentavos: 0 }, { ...base, modo: 'completo' }, segunda10h)).toMatchObject({ ok: false });
    expect(validateOrderRequest({ ...s, precoCompletoCentavos: 0 }, base, segunda10h).ok).toBe(true);
  });
  test('quantidade inválida', () => {
    for (const quantidade of [0, -1, 1.5, NaN]) {
      expect(validateOrderRequest(s, { ...base, quantidade }, segunda10h).ok).toBe(false);
    }
  });
  test('pagamento não aceito pela loja', () =>
    expect(validateOrderRequest({ ...s, pagamentos: ['cartao'] }, { ...base, pagamento: 'pix_entrega' }, segunda10h).ok).toBe(false));
  test('endereço incompleto gera um erro por campo faltante', () => {
    const r = validateOrderRequest(s, { ...base, endereco: { rua: '', numero: ' ', bairro: '' } }, segunda10h);
    expect(erros(r)).toHaveLength(3);
    expect(validateOrderRequest(s, { ...base, endereco: undefined }, segunda10h)).toMatchObject({ ok: false });
  });
  test('pix antecipado sem chave', () =>
    expect(validateOrderRequest({ ...s, chavePix: null }, { ...base, pagamento: 'pix_antecipado' }, segunda10h).ok).toBe(false));
  test('fora do horário vira agendado; 4 botijões precisa revisão', () => {
    const r = validateOrderRequest(s, { ...base, quantidade: 4 }, new Date('2026-11-02T23:30:00Z'));
    expect(r).toMatchObject({ ok: true, agendado: true, precisaRevisao: true });
  });
  test('gás do povo recusado quando loja não aceita', () =>
    expect(validateOrderRequest({ ...s, gasDoPovo: { ...s.gasDoPovo, aceita: false } }, { ...base, pagamento: 'gas_do_povo' }, segunda10h)).toMatchObject({ ok: false }));
  test('gás do povo em retirada: tipo retirada, sem endereço, nunca agendado', () => {
    const r = { ...s, gasDoPovo: { ...s.gasDoPovo, modalidade: 'retirada' as const } };
    expect(validateOrderRequest(r, { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo' }, new Date('2026-11-02T23:30:00Z')))
      .toMatchObject({ ok: true, tipo: 'retirada', agendado: false });
  });
  test('gás do povo em entrega exige endereço', () =>
    expect(validateOrderRequest(s, { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo' }, segunda10h).ok).toBe(false));
});
