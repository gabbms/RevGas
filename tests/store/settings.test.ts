import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { getSettings, updateSettings } from '../../src/store/settings.js';

describe('settings', () => {
  test('getSettings devolve padrões quando vazio', () => {
    const db = openDb(':memory:');
    const s = getSettings(db);
    expect(s.precoRecargaCentavos).toBe(0);
    expect(s.horarios.dom).toEqual({ abre: '08:00', fecha: '13:00' });
    expect(s.fuso).toBe('America/Sao_Paulo');
  });

  test('updateSettings persiste e normaliza telefones', () => {
    const db = openDb(':memory:');
    const s = { ...getSettings(db), precoRecargaCentavos: 11500, telefoneDono: '(86) 99999-1234' };
    updateSettings(db, s);
    expect(getSettings(db).telefoneDono).toBe('5586999991234');
    expect(getSettings(db).precoRecargaCentavos).toBe(11500);
  });

  test('updateSettings rejeita preço negativo e abre >= fecha', () => {
    const db = openDb(':memory:');
    expect(() => updateSettings(db, { ...getSettings(db), precoRecargaCentavos: -1 })).toThrow();
    expect(() =>
      updateSettings(db, { ...getSettings(db), horarios: { ...getSettings(db).horarios, seg: { abre: '20:00', fecha: '07:00' } } }),
    ).toThrow();
  });
});
