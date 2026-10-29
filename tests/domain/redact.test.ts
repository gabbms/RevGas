import { describe, expect, test } from 'vitest';
import { redactSensitive } from '../../src/domain/redact.js';

describe('redactSensitive', () => {
  test('CPF sempre mascarado', () => {
    expect(redactSensitive('meu cpf é 123.456.789-09', { contextoGasDoPovo: false })).toEqual({
      texto: 'meu cpf é [CPF removido]',
      removido: true,
    });
  });
  test('CPF sem pontuação também', () => {
    expect(redactSensitive('12345678909', { contextoGasDoPovo: false }).texto).toBe('[CPF removido]');
  });
  test('código só em contexto Gás do Povo', () => {
    expect(redactSensitive('482913', { contextoGasDoPovo: true })).toEqual({ texto: '[código removido]', removido: true });
    expect(redactSensitive(' 482913 ', { contextoGasDoPovo: true }).texto).toBe('[código removido]');
    expect(redactSensitive('482913', { contextoGasDoPovo: false })).toEqual({ texto: '482913', removido: false });
    expect(redactSensitive('troco pra 200', { contextoGasDoPovo: true })).toEqual({ texto: 'troco pra 200', removido: false });
  });
  test('número curto em contexto não é código', () => {
    expect(redactSensitive('123', { contextoGasDoPovo: true }).texto).toBe('123');
  });
});
