import { describe, expect, test } from 'vitest';
import { normalizePhone, samePhone } from '../../src/domain/phone.js';

describe('phone', () => {
  test('normalizePhone mantém só dígitos e prefixa 55 em 10–11 dígitos', () => {
    expect(normalizePhone('(86) 99999-1234')).toBe('5586999991234');
    expect(normalizePhone('+55 86 99999-1234')).toBe('5586999991234');
    expect(normalizePhone('8699991234')).toBe('558699991234');
  });

  test('samePhone com e sem nono dígito', () => {
    expect(samePhone('5586999991234', '558699991234')).toBe(true);
    expect(samePhone('5586999991234', '5586999991235')).toBe(false);
  });
});
