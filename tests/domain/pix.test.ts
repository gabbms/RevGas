import { describe, expect, test } from 'vitest';
import { isPixKey } from '../../src/domain/pix.js';

describe('isPixKey', () => {
  test.each([
    ['CPF só dígitos', '12345678909'],
    ['CPF com pontuação', '123.456.789-09'],
    ['CNPJ com pontuação', '00.000.000/0001-00'],
    ['CNPJ só dígitos', '00000000000100'],
    ['CNPJ alfanumérico', '12.ABC.345/01DE-35'],
    ['e-mail', 'loja@exemplo.com.br'],
    ['telefone com +55', '+5586999990000'],
    ['telefone formatado', '(86) 99999-0000'],
    ['telefone sem 55', '86999990000'],
    ['chave aleatória', '123e4567-e89b-12d3-a456-426614174000'],
    ['com espaços nas pontas', '  loja@exemplo.com  '],
  ])('aceita %s', (_nome, chave) => {
    expect(isPixKey(chave)).toBe(true);
  });

  test.each([
    ['texto de exemplo', 'chave-pix-aqui'],
    ['vazio', ''],
    ['só espaços', '   '],
    ['prefixo escrito', 'cnpj 00.000.000/0001-00'],
    ['e-mail sem domínio', 'loja@exemplo'],
    ['número curto', '12345'],
    ['aleatória incompleta', '123e4567-e89b-12d3-a456'],
    ['longa demais', 'a'.repeat(70) + '@exemplo.com'],
  ])('recusa %s', (_nome, chave) => {
    expect(isPixKey(chave)).toBe(false);
  });
});
