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
  test('com palavra-chave, qualquer sequência isolada de 4 a 8 dígitos é mascarada', () => {
    expect(redactSensitive('meu código é 482913', { contextoGasDoPovo: false })).toEqual({
      texto: 'meu código é [código removido]',
      removido: true,
    });
    expect(redactSensitive('minha senha é 1234', { contextoGasDoPovo: false }).texto).toBe('minha senha é [código removido]');
    expect(redactSensitive('chegou o SMS 55667788 aqui', { contextoGasDoPovo: false }).texto).toBe(
      'chegou o SMS [código removido] aqui',
    );
    expect(redactSensitive('quero pelo Gás do Povo, 4829', { contextoGasDoPovo: false }).texto).toBe(
      'quero pelo Gás do Povo, [código removido]',
    );
    // Números maiores que 8 dígitos ou menores que 4 ficam.
    expect(redactSensitive('codigo 123456789 e 12', { contextoGasDoPovo: false }).texto).toBe('codigo 123456789 e 12');
  });
  test('sem palavra-chave e sem contexto, número no meio do texto fica', () => {
    expect(redactSensitive('rua 1250', { contextoGasDoPovo: false })).toEqual({ texto: 'rua 1250', removido: false });
    expect(redactSensitive('rua 1250', { contextoGasDoPovo: true })).toEqual({ texto: 'rua 1250', removido: false });
  });
});
