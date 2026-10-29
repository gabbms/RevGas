import { normalizeText } from './order-validation.js';
import { samePhone } from './phone.js';
import type { StoreSettings } from '../store/settings.js';

export type StaffReply = 'saiu' | 'entregue' | 'problema';

// A ordem importa: "problema" vence "entregue", que vence "saiu".
const RULES: ReadonlyArray<readonly [StaffReply, readonly string[]]> = [
  ['problema', ['problema', 'nao atende', 'ninguem', 'nao encontr', 'endereco errado', 'cancel', 'nao tem ninguem']],
  ['entregue', ['entreg', 'feito', 'finalizado']],
  ['saiu', ['saiu', 'saindo', 'a caminho', 'indo', 'sai agora', 'rota']],
];

// Palavras curtas que apareceriam no meio de outras ("lindo", "frota"): só valem inteiras.
const WHOLE_WORD = new Set(['indo', 'rota', 'feito']);

export function parseStaffReply(texto: string): StaffReply | null {
  const t = normalizeText(texto);
  for (const [reply, words] of RULES) {
    if (words.some((w) => (WHOLE_WORD.has(w) ? new RegExp(String.raw`\b${w}\b`).test(t) : t.includes(w)))) return reply;
  }
  return null;
}

/** Entregador cadastrado ou o dono. */
export function isStaffPhone(s: StoreSettings, telefone: string): boolean {
  if (s.telefoneDono.trim() !== '' && samePhone(s.telefoneDono, telefone)) return true;
  return s.entregadores.some((e) => samePhone(e.telefone, telefone));
}
