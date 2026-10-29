import { describe, expect, test } from 'vitest';
import { quote } from '../../src/domain/pricing.js';
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

describe('quote', () => {
  test('2 troca dinheiro', () =>
    expect(quote(s, { quantidade: 2, modo: 'troca', pagamento: 'dinheiro' })).toEqual({
      unitarioCentavos: 11500, cascoCentavos: 0, taxaEntregaCentavos: 0, totalCentavos: 23000,
    }));
  test('1 completo', () =>
    expect(quote(s, { quantidade: 1, modo: 'completo', pagamento: 'cartao' }).totalCentavos).toBe(32000));
  test('gás do povo troca = só taxa', () =>
    expect(quote(s, { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo' }).totalCentavos).toBe(500));
  test('gás do povo sem vazio paga casco', () =>
    expect(quote(s, { quantidade: 1, modo: 'completo', pagamento: 'gas_do_povo' })).toMatchObject({
      cascoCentavos: 20500, totalCentavos: 21000,
    }));
  test('gás do povo: taxa uma vez por pedido, casco por unidade', () =>
    expect(quote(s, { quantidade: 2, modo: 'completo', pagamento: 'gas_do_povo' }).totalCentavos).toBe(41500));
  test('gás do povo retirada sem taxa', () => {
    const r = { ...s, gasDoPovo: { ...s.gasDoPovo, modalidade: 'retirada' as const } };
    expect(quote(r, { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo' }).totalCentavos).toBe(0);
  });
});
