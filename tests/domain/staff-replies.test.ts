import { describe, expect, test } from 'vitest';
import { isStaffPhone, parseStaffReply } from '../../src/domain/staff-replies.js';
import { DEFAULT_SETTINGS } from '../../src/store/settings.js';

describe('parseStaffReply', () => {
  test.each([
    ['Saindo agora', 'saiu'],
    ['a caminho', 'saiu'],
    ['entreguei', 'entregue'],
    ['Feito!', 'entregue'],
    ['cliente não atende', 'problema'],
    ['endereço errado', 'problema'],
    ['não tem ninguém', 'problema'],
    ['bom dia', null],
    ['', null],
  ])('%s → %s', (t, r) => expect(parseStaffReply(t)).toBe(r));

  test('problema tem prioridade sobre entregue', () => {
    expect(parseStaffReply('não entreguei, ninguém em casa')).toBe('problema');
  });
});

describe('isStaffPhone', () => {
  const s = { ...DEFAULT_SETTINGS, telefoneDono: '5586999990000', entregadores: [{ nome: 'João', telefone: '5586911110000' }] };

  test('entregador, dono (com variante do 9º dígito) e estranho', () => {
    expect(isStaffPhone(s, '5586911110000')).toBe(true);
    expect(isStaffPhone(s, '558699990000')).toBe(true);
    expect(isStaffPhone(s, '5586955550000')).toBe(false);
  });

  test('dono vazio não casa com nada', () => {
    expect(isStaffPhone({ ...s, telefoneDono: '' }, '')).toBe(false);
  });
});
