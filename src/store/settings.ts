import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { normalizePhone } from '../domain/phone.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM');

const DayHoursSchema = z
  .object({ abre: hhmm, fecha: hhmm })
  .refine((h) => h.abre < h.fecha, { message: 'O horário de abertura deve ser antes do fechamento' })
  .nullable();

const PaymentSchema = z.enum(['dinheiro', 'cartao', 'pix_entrega', 'pix_antecipado', 'gas_do_povo']);
const cents = z.number().int().min(0);

const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const StoreSettingsSchema = z.object({
  nomeLoja: z.string().min(1),
  enderecoLoja: z.string(),
  precoRecargaCentavos: cents,
  precoCompletoCentavos: cents,
  previsaoEntregaMin: z.number().int().positive(),
  horarios: z.object({
    dom: DayHoursSchema,
    seg: DayHoursSchema,
    ter: DayHoursSchema,
    qua: DayHoursSchema,
    qui: DayHoursSchema,
    sex: DayHoursSchema,
    sab: DayHoursSchema,
  }),
  bairros: z.array(z.string().min(1)),
  pagamentos: z.array(PaymentSchema),
  chavePix: z.string().min(1).nullable(),
  telefoneDono: z.string(),
  entregadores: z.array(z.object({ nome: z.string().min(1), telefone: z.string().min(1) })),
  destinoPedidos: z.enum(['entregadores', 'dono']),
  gasDoPovo: z.object({
    aceita: z.boolean(),
    modalidade: z.enum(['entrega', 'retirada']),
    taxaEntregaCentavos: cents,
  }),
  lembretesAtivos: z.boolean(),
  fuso: z.string().refine(isValidTimeZone, { message: 'Fuso horário inválido' }),
});

export type StoreSettings = z.infer<typeof StoreSettingsSchema>;

const semana = { abre: '07:00', fecha: '20:00' };

export const DEFAULT_SETTINGS: StoreSettings = {
  nomeLoja: 'Revenda de Gás',
  enderecoLoja: '',
  precoRecargaCentavos: 0,
  precoCompletoCentavos: 0,
  previsaoEntregaMin: 40,
  horarios: {
    dom: { abre: '08:00', fecha: '13:00' },
    seg: { ...semana },
    ter: { ...semana },
    qua: { ...semana },
    qui: { ...semana },
    sex: { ...semana },
    sab: { ...semana },
  },
  bairros: [],
  pagamentos: ['dinheiro', 'cartao', 'pix_entrega'],
  chavePix: null,
  telefoneDono: '',
  entregadores: [],
  destinoPedidos: 'dono',
  gasDoPovo: { aceita: false, modalidade: 'entrega', taxaEntregaCentavos: 0 },
  lembretesAtivos: true,
  fuso: 'America/Sao_Paulo',
};

export function getSettings(db: Db): StoreSettings {
  const row = db.prepare('SELECT json FROM settings WHERE id = 1').get() as { json: string } | undefined;
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  return StoreSettingsSchema.parse(JSON.parse(row.json));
}

/** Valida (lança ZodError), normaliza os telefones e persiste. */
export function updateSettings(db: Db, s: StoreSettings): StoreSettings {
  const parsed = StoreSettingsSchema.parse(s);
  const normalized: StoreSettings = {
    ...parsed,
    telefoneDono: normalizePhone(parsed.telefoneDono),
    entregadores: parsed.entregadores.map((e) => ({ ...e, telefone: normalizePhone(e.telefone) })),
  };
  db.prepare(
    'INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
  ).run(JSON.stringify(normalized));
  return normalized;
}
