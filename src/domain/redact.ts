const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CODIGO = /^\s*\d{4,8}\s*$/;

/** Remove dados que nunca devem ser gravados nem enviados ao modelo. */
export function redactSensitive(texto: string, o: { contextoGasDoPovo: boolean }): { texto: string; removido: boolean } {
  if (o.contextoGasDoPovo && CODIGO.test(texto)) return { texto: '[código removido]', removido: true };
  const semCpf = texto.replace(CPF, '[CPF removido]');
  return { texto: semCpf, removido: semCpf !== texto };
}
