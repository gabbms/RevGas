import type { StoreSettings } from '../store/settings.js';
import type { WeekdayKey } from './types.js';

const KEYS: WeekdayKey[] = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const LABELS: Record<WeekdayKey, string> = {
  dom: 'Dom', seg: 'Seg', ter: 'Ter', qua: 'Qua', qui: 'Qui', sex: 'Sex', sab: 'Sáb',
};
// Ordem de exibição: segunda a domingo
const DISPLAY_ORDER: WeekdayKey[] = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(now: Date, fuso: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function localDateKey(now: Date, fuso: string): string {
  const p = localParts(now, fuso);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localHour(now: Date, fuso: string): number {
  return localParts(now, fuso).hour;
}

function weekdayOf(year: number, month: number, day: number): WeekdayKey {
  return KEYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

export function isOpen(s: StoreSettings, now: Date): boolean {
  const p = localParts(now, s.fuso);
  const h = s.horarios[weekdayOf(p.year, p.month, p.day)];
  if (!h) return false;
  const cur = p.hour * 60 + p.minute;
  return cur >= toMinutes(h.abre) && cur < toMinutes(h.fecha);
}

/** Instante UTC em que o relógio local de `fuso` marca a data/hora dadas. */
function zonedToUtc(year: number, month: number, day: number, minutes: number, fuso: string): Date {
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), fuso);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wall - asUtc;
  }
  return new Date(guess);
}

export function nextOpening(s: StoreSettings, now: Date): Date | null {
  const p = localParts(now, s.fuso);
  for (let offset = 0; offset <= 7; offset++) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const h = s.horarios[weekdayOf(y, m, day)];
    if (!h) continue;
    const at = zonedToUtc(y, m, day, toMinutes(h.abre), s.fuso);
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

export function formatHorarios(s: StoreSettings): string {
  const range = (k: WeekdayKey): string | null => {
    const h = s.horarios[k];
    return h ? `${h.abre}–${h.fecha}` : null;
  };
  const groups: { days: WeekdayKey[]; range: string }[] = [];
  for (const k of DISPLAY_ORDER) {
    const r = range(k);
    if (r === null) continue;
    const last = groups[groups.length - 1];
    const prev = last?.days[last.days.length - 1];
    if (last && last.range === r && prev && DISPLAY_ORDER.indexOf(prev) === DISPLAY_ORDER.indexOf(k) - 1) {
      last.days.push(k);
    } else {
      groups.push({ days: [k], range: r });
    }
  }
  return groups
    .map((g) => {
      const first = LABELS[g.days[0]!];
      const lastD = LABELS[g.days[g.days.length - 1]!];
      const label = g.days.length === 1 ? first : g.days.length === 2 ? `${first} e ${lastD}` : `${first} a ${lastD}`;
      return `${label} ${g.range}`;
    })
    .join(' · ');
}
