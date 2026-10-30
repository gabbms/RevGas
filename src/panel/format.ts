import { isOpen, nextOpening, todayHours } from '../domain/hours.js';
import type { StoreSettings } from '../store/settings.js';

/** Telefone para leitura: 5586988120455 → (86) 98812-0455. Outros formatos voltam como vieram. */
export function formatPhone(telefone: string): string {
  const d = telefone.replace(/\D/g, '');
  const local = d.length >= 12 && d.startsWith('55') ? d.slice(2) : d;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return telefone;
}

/** Minutos inteiros entre `desde` e `agora` (nunca negativo). */
export const minutesSince = (desde: Date, agora: Date): number =>
  Math.max(0, Math.floor((agora.getTime() - desde.getTime()) / 60_000));

/** "agora", "há 8 min", "há 1 h 05 min", "há 2 dias". */
export function ago(desde: Date, agora: Date): string {
  const m = minutesSince(desde, agora);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `há ${h} h` : `há ${h} h ${String(m % 60).padStart(2, '0')} min`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'ontem' : `há ${d} dias`;
}

export type StoreStatus = { aberta: boolean; texto: string; semHorario: boolean };

/** O que a barra do topo diz sobre a loja agora (o bot age conforme isso). */
export function storeStatus(s: StoreSettings, agora: Date): StoreStatus {
  const semHorario = Object.values(s.horarios).every((h) => h === null);
  if (semHorario) return { aberta: false, semHorario, texto: 'Sem horário de funcionamento: o bot só agenda pedidos' };
  if (isOpen(s, agora)) return { aberta: true, semHorario, texto: `Loja aberta · fecha às ${todayHours(s, agora)!.fecha}` };
  const prox = nextOpening(s, agora);
  if (!prox) return { aberta: false, semHorario, texto: 'Loja fechada' };
  return { aberta: false, semHorario, texto: `Loja fechada · abre ${quando(prox, agora, s.fuso)}` };
}

/** "hoje às 07:00", "amanhã às 07:00", "sábado às 07:00" (no fuso da loja). */
export function quando(alvo: Date, agora: Date, fuso: string): string {
  const dia = (d: Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, dateStyle: 'short' }).format(d);
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit' }).format(alvo);
  if (dia(alvo) === dia(agora)) return `hoje às ${hora}`;
  if (dia(alvo) === dia(new Date(agora.getTime() + 24 * 60 * 60 * 1000))) return `amanhã às ${hora}`;
  return `${new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, weekday: 'long' }).format(alvo)} às ${hora}`;
}
