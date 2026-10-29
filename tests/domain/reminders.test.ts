import { describe, expect, test } from 'vitest';
import { dueForReminder, nextReorderDate, REMINDER_TEXT } from '../../src/domain/reminders.js';

const d = (s: string) => new Date(`${s}T12:00:00Z`);
const base = { entregas: [d('2026-09-01'), d('2026-10-01')], ultimoLembreteEm: null, temPedidoAberto: false, lembretesDesativados: false };

describe('nextReorderDate', () => {
  test('próxima recompra pela média', () =>
    expect(nextReorderDate([d('2026-09-01'), d('2026-10-01'), d('2026-10-29')])?.toISOString().slice(0, 10)).toBe('2026-11-27'));
  test('menos de 2 entregas → null', () => {
    expect(nextReorderDate([])).toBeNull();
    expect(nextReorderDate([d('2026-10-01')])).toBeNull();
  });
  test('ordena datas desordenadas', () =>
    expect(nextReorderDate([d('2026-10-01'), d('2026-09-01')])?.toISOString().slice(0, 10)).toBe('2026-10-31'));
});

describe('dueForReminder', () => {
  test('1 entrega não gera lembrete', () =>
    expect(dueForReminder({ ...base, entregas: [d('2026-10-01')] }, d('2026-11-30'))).toBe(false));
  test('dentro da margem gera; já lembrado neste ciclo não', () => {
    expect(dueForReminder(base, d('2026-10-29'))).toBe(true);
    expect(dueForReminder({ ...base, ultimoLembreteEm: d('2026-10-29') }, d('2026-10-29'))).toBe(false);
  });
  test('antes da margem não gera', () => expect(dueForReminder(base, d('2026-10-28'))).toBe(false));
  test('lembrete de ciclo anterior não bloqueia', () =>
    expect(dueForReminder({ ...base, ultimoLembreteEm: d('2026-09-28') }, d('2026-10-29'))).toBe(true));
  test('desativado ou com pedido aberto não gera', () => {
    expect(dueForReminder({ ...base, lembretesDesativados: true }, d('2026-10-31'))).toBe(false);
    expect(dueForReminder({ ...base, temPedidoAberto: true }, d('2026-10-31'))).toBe(false);
  });
});

test('REMINDER_TEXT', () => {
  expect(REMINDER_TEXT('Ana', 'R$ 115,00')).toBe('Oi, Ana! Pelo seu histórico, seu gás deve estar acabando nos próximos dias 🔥 Quer que eu já mande um P13 (R$ 115,00)? Responda "sim" que eu preparo o pedido.');
  expect(REMINDER_TEXT(null, 'R$ 115,00')).toMatch(/^Oi! Pelo/);
});
