const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALEATORIA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Confere só o formato de uma chave Pix (não consulta o banco): CPF, CNPJ, e-mail, telefone ou chave aleatória.
 * Serve para barrar texto de exemplo ("chave-pix-aqui"), que o cliente tentaria pagar de verdade.
 */
export function isPixKey(chave: string): boolean {
  const k = chave.trim();
  if (k.length === 0 || k.length > 77) return false;
  if (EMAIL.test(k)) return true;
  if (ALEATORIA.test(k)) return true;
  // CNPJ: 14 caracteres (letras e números, desde 2026), com ou sem pontuação.
  if (/^[0-9A-Za-z]{2}\.?[0-9A-Za-z]{3}\.?[0-9A-Za-z]{3}\/?[0-9A-Za-z]{4}-?[0-9]{2}$/.test(k)) return true;
  // CPF, ou telefone com DDD (com ou sem +55), com ou sem pontuação.
  if (/^[0-9+().\s-]+$/.test(k)) {
    const digitos = k.replace(/\D/g, '');
    if (digitos.length === 11) return true; // CPF, ou DDD + celular
    if (digitos.length === 10) return true; // DDD + fixo
    if (digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)) return true;
  }
  return false;
}

export const PIX_KEY_HELP = 'Use CPF, CNPJ, e-mail, telefone com DDD ou chave aleatória.';
