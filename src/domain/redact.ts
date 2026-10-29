import { normalizeText } from './order-validation.js';

const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CODIGO = /^\s*\d{4,8}\s*$/;
/** Sequência de 4 a 8 dígitos que não encosta em outro dígito. */
const CODIGO_SOLTO = /(?<!\d)\d{4,8}(?!\d)/g;
const PALAVRAS_CODIGO = ['codigo', 'senha', 'sms', 'gas do povo'];

/** Remove dados que nunca devem ser gravados nem enviados ao modelo. */
export function redactSensitive(texto: string, o: { contextoGasDoPovo: boolean }): { texto: string; removido: boolean } {
  if (o.contextoGasDoPovo && CODIGO.test(texto)) return { texto: '[código removido]', removido: true };
  let out = texto.replace(CPF, '[CPF removido]');
  // Falou de código/senha/SMS/Gás do Povo: qualquer número de 4 a 8 dígitos pode ser o código do benefício.
  const n = normalizeText(texto);
  if (PALAVRAS_CODIGO.some((p) => n.includes(p))) out = out.replace(CODIGO_SOLTO, '[código removido]');
  return { texto: out, removido: out !== texto };
}
