import { describe, expect, test } from 'vitest';
import { ago, formatPhone, quando, storeStatus } from '../../src/panel/format.js';
import { DEFAULT_SETTINGS } from '../../src/store/settings.js';

// Segunda, 02/11/2026, 10:00 em Brasília.
const SEGUNDA_10H = new Date('2026-11-02T13:00:00Z');

describe('painel: formatos', () => {
  test('telefone legível com DDD; formato desconhecido volta igual', () => {
    expect(formatPhone('5586988120455')).toBe('(86) 98812-0455');
    expect(formatPhone('558694264580')).toBe('(86) 9426-4580');
    expect(formatPhone('abc')).toBe('abc');
  });

  test('tempo relativo', () => {
    const t = SEGUNDA_10H.getTime();
    expect(ago(new Date(t - 30_000), SEGUNDA_10H)).toBe('agora');
    expect(ago(new Date(t - 8 * 60_000), SEGUNDA_10H)).toBe('há 8 min');
    expect(ago(new Date(t - 65 * 60_000), SEGUNDA_10H)).toBe('há 1 h 05 min');
    expect(ago(new Date(t - 26 * 3_600_000), SEGUNDA_10H)).toBe('ontem');
  });

  test('quando: hoje, amanhã ou o dia da semana', () => {
    const f = DEFAULT_SETTINGS.fuso;
    expect(quando(new Date('2026-11-02T17:00:00Z'), SEGUNDA_10H, f)).toBe('hoje às 14:00');
    expect(quando(new Date('2026-11-03T10:00:00Z'), SEGUNDA_10H, f)).toBe('amanhã às 07:00');
    expect(quando(new Date('2026-11-05T10:00:00Z'), SEGUNDA_10H, f)).toBe('quinta-feira às 07:00');
  });

  test('status da loja: aberta, fechada até a próxima abertura, ou sem horário', () => {
    const s = { ...DEFAULT_SETTINGS, horarios: { ...DEFAULT_SETTINGS.horarios, seg: { abre: '07:00', fecha: '19:00' } } };
    expect(storeStatus(s, SEGUNDA_10H)).toMatchObject({ aberta: true, texto: 'Loja aberta · fecha às 19:00' });
    expect(storeStatus(s, new Date('2026-11-02T23:00:00Z')).texto).toMatch(/^Loja fechada · abre amanhã às /);
    const semHorario = { ...s, horarios: { dom: null, seg: null, ter: null, qua: null, qui: null, sex: null, sab: null } };
    expect(storeStatus(semHorario, SEGUNDA_10H)).toMatchObject({ aberta: false, semHorario: true });
  });
});
