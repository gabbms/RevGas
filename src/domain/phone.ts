/** Só dígitos; com 10–11 dígitos (DDD + número), prefixa o código do Brasil. */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  return digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
}

/** Remove o 9º dígito de celulares brasileiros (55 + DDD + 9 + 8 dígitos). */
function withoutNinthDigit(phone: string): string {
  if (phone.length === 13 && phone.startsWith('55') && phone[4] === '9') {
    return phone.slice(0, 4) + phone.slice(5);
  }
  return phone;
}

export function samePhone(a: string, b: string): boolean {
  return withoutNinthDigit(normalizePhone(a)) === withoutNinthDigit(normalizePhone(b));
}
