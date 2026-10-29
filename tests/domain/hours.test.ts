import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/store/settings.js';
import { formatHorarios, isOpen, localDateKey, localHour, nextOpening } from '../../src/domain/hours.js';
import { formatBRL } from '../../src/domain/money.js';

const s = { ...DEFAULT_SETTINGS }; // seg–sáb 07–20, dom 08–13, fuso SP (UTC-3)

describe('hours', () => {
  test('aberto segunda 10h local', () => expect(isOpen(s, new Date('2026-11-02T13:00:00Z'))).toBe(true));
  test('fechado segunda 20h local (fecha exclusivo)', () =>
    expect(isOpen(s, new Date('2026-11-02T23:00:00Z'))).toBe(false));
  test('aberto segunda 07h local (abre inclusivo)', () =>
    expect(isOpen(s, new Date('2026-11-02T10:00:00Z'))).toBe(true));
  test('domingo 14h fechado; próxima abertura segunda 07h', () => {
    const now = new Date('2026-11-01T17:00:00Z');
    expect(isOpen(s, now)).toBe(false);
    expect(nextOpening(s, now)?.toISOString()).toBe('2026-11-02T10:00:00.000Z');
  });
  test('antes de abrir, próxima abertura é hoje', () =>
    expect(nextOpening(s, new Date('2026-11-02T09:00:00Z'))?.toISOString()).toBe('2026-11-02T10:00:00.000Z'));
  test('tudo fechado retorna null', () => {
    const closed = { ...s, horarios: { dom: null, seg: null, ter: null, qua: null, qui: null, sex: null, sab: null } };
    expect(nextOpening(closed, new Date('2026-11-02T13:00:00Z'))).toBeNull();
  });
  test('formatHorarios agrupa', () =>
    expect(formatHorarios(s)).toBe('Seg a Sáb 07:00–20:00 · Dom 08:00–13:00'));
  test('formatHorarios não agrupa dias não consecutivos nem fechados', () => {
    const h = { ...s, horarios: { ...s.horarios, qua: null, dom: null } };
    expect(formatHorarios(h)).toBe('Seg e Ter 07:00–20:00 · Qui a Sáb 07:00–20:00');
  });
  test('localDateKey e localHour usam o fuso', () => {
    const d = new Date('2026-11-02T01:30:00Z'); // 01/11 22:30 em SP
    expect(localDateKey(d, 'America/Sao_Paulo')).toBe('2026-11-01');
    expect(localHour(d, 'America/Sao_Paulo')).toBe(22);
  });
});

describe('money', () => {
  test('formatBRL', () => expect(formatBRL(11500)).toBe('R$ 115,00'));
  test('formatBRL com milhar', () => expect(formatBRL(123456)).toBe('R$ 1.234,56'));
});
